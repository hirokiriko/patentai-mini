import { z } from "zod";
import { managedClaimContext, type ManagedClaimSet, type ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { ComparisonError } from "./source";
import { referenceLogicInput } from "./reference-logic";
import { compareAttributedStructure, literalStructureInput } from "./literal-structure";
import { generationQuoteRanges, type GenerationQuoteOptions } from "./generation-quote-options";
import { isNominalReservationText } from "./reservation-topic";

const claimNo = z.number().int().positive();
const text = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f-\x9f]*$/);
const evidenceId = z.string().min(1).max(100).regex(/^[bc][a-f0-9]{64}:\d+:\d+:\d+(?::\d+)?$/);
// Source observations precede comparison. They are bounded generation aids,
// not a second semantic validator or a change to the immutable saved format.
export const generationSchema = z.object({ results: z.array(z.object({
  baseClaimNo: claimNo, candidateClaimNo: claimNo,
  baseObservation: text.max(120), candidateObservation: text.max(120),
  common: text, differences: text, unconfirmed: text.max(120).describe("Nominal uncertainty topics only, e.g. 候補側の起動時の制御は未確認。 or 弁の対応関係は未確認。 Keep the actual scope; do not replace it with generic uncertainty. Do not embed a factual/conditional clause such as 弁を開く際 or いずれに対応するか. Separate multiple nominal topics with 。."),
  baseEvidenceId: evidenceId, candidateEvidenceId: evidenceId,
}).strict()).min(1).max(2) }).strict();
export type GenerationAnswer = z.infer<typeof generationSchema>;
type Segment = { id: string; text: string; quotable: boolean };

export function sourceSegments(source: ManagedClaimSet, prefix: string) {
  return { ...source, claims: source.claims.map(({ text, ...claim }) => {
    const segments: Segment[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 120, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      // Prefer a sentence/clause boundary without omitting even whitespace.
      if (end < text.length) {
        for (let at = end; at > start + 60; at--) {
          if (/[。；;、\n]/.test(text[at - 1])) { end = at; break; }
        }
      }
      const quote = text.slice(start, end);
      const quotable = !!quote.trim() && text.indexOf(quote) === start && text.indexOf(quote, start + 1) < 0;
      segments.push({ id: `${prefix}:${claim.claimNo}:${start}`, text: quote, quotable });
      start = end;
    }
    return { ...claim, segments };
  }) };
}

/** Full source, losslessly partitioned; no second copy or generated quote text. */
export function generationInput(chunk: ManagedComparisonChunk, quotes?: GenerationQuoteOptions) {
  const quotedSource = (source: ManagedClaimSet, prefix: string) => {
    const split = sourceSegments(source, prefix);
    return { ...split, claims: split.claims.map(c => ({ ...c, ...(quotes ? { quoteRanges: generationQuoteRanges(source, prefix, quotes).filter(r => r.claimNo === c.claimNo).map(r => [r.start, r.end]) } : {}) })) };
  };
  return { ...chunk,
    pairs: chunk.pairs.map(pair => ({ ...pair,
      baseContextClaimNos: managedClaimContext(chunk.base, [pair.baseClaimNo]).claims.map(c => c.claimNo),
      candidateContextClaimNos: managedClaimContext(chunk.candidate, [pair.candidateClaimNo]).claims.map(c => c.claimNo),
    })),
    base: { ...quotedSource(chunk.base, `b${chunk.baseDigest}:0`),
      ...literalStructureInput(chunk.base),
      referenceLogic: referenceLogicInput(chunk.base, [...new Set(chunk.pairs.map(p => p.baseClaimNo))]) },
    candidate: { ...quotedSource(chunk.candidate, `c${chunk.candidateDigest}:${chunk.candidateId}`),
      ...literalStructureInput(chunk.candidate),
      referenceLogic: referenceLogicInput(chunk.candidate, [...new Set(chunk.pairs.map(p => p.candidateClaimNo))]) },
  };
}

export function assertGenerationEvidence(chunk: ManagedComparisonChunk): void {
  const input = generationInput(chunk);
  for (const pair of chunk.pairs) {
    for (const [side, no] of [["base", pair.baseClaimNo], ["candidate", pair.candidateClaimNo]] as const) {
      const allowed = new Set(managedClaimContext(chunk[side], [no]).claims.map(c => c.claimNo));
      if (!input[side].claims.some(c => allowed.has(c.claimNo) && c.segments.some(s => s.quotable))) {
        throw new ComparisonError("source_review_required");
      }
    }
  }
}

export function generationSchemaFor(chunk: ManagedComparisonChunk, quotes?: GenerationQuoteOptions) {
  const input = generationInput(chunk, quotes);
  const ids = (side: "base" | "candidate") => [...new Set([...input[side].claims.flatMap(c => c.segments.filter(s => s.quotable).map(s => s.id)), ...(quotes ? generationQuoteRanges(chunk[side], side === "base" ? `b${chunk.baseDigest}:0` : `c${chunk.candidateDigest}:${chunk.candidateId}`, quotes).map(r => r.id) : [])])];
  const base = ids("base"), candidate = ids("candidate");
  // Structured-output enum capacity is independent of the input-byte budget.
  // Reject the entire plan before reserving/sending; never discard candidates.
  if (base.length + candidate.length > 1000 || [base, candidate].some(values => values.length > 250 && values.join("").length > 15000)) {
    throw new ComparisonError("plan_limit");
  }
  return generationSchema.extend({ results: z.array(generationSchema.shape.results.element.extend({
    baseEvidenceId: z.enum(base), candidateEvidenceId: z.enum(candidate),
  })).min(1).max(2) });
}

/** Resolve only the requested side's literal segment; managed validation then
 * checks per-pair reference closure, exact unique quotes, positions and coverage. */
export function decodeGeneration(chunk: ManagedComparisonChunk, answer: unknown, quotes?: GenerationQuoteOptions) {
  try {
    const parsed = generationSchema.parse(answer);
    if(parsed.results.some(r=>!isNominalReservationText(r.unconfirmed)))throw Error();
    for (const result of parsed.results) for (const side of ["base", "candidate"] as const) {
      const source = managedClaimContext(chunk[side], [result[`${side}ClaimNo`]]);
      for (const field of ["baseObservation", "candidateObservation", "common", "differences", "unconfirmed"] as const) {
        if (field === (side === "base" ? "candidateObservation" : "baseObservation")) continue;
        if (compareAttributedStructure(source, result[field], side, field === `${side}Observation`).length) throw Error();
      }
    }
    // Protocol metadata is not a patent condition or a reason that source text
    // cannot be compared. Apply this only to new generations, not saved readers.
    if (parsed.results.some(r => /quoteRanges|quotable|literalStructure|referenceLogic|referenceClauses|guaranteedClaimNos|conditionalClaimNos|unknownClaimNos|rejectedTargetSpan|rejectedTargetAnchor|unitStarts|unitChecks|targetReading|sourceComparison|inspectedKinds|basisQuote|assertionStatus|evidenceIds|sourceFacts|factIds|(?:base|candidate)(?:EvidenceId|ContextClaimNos)/i.test(
      [r.baseObservation, r.candidateObservation, r.common, r.differences, r.unconfirmed].join("\n"),
    ))) throw Error();
    const input = generationInput(chunk, quotes);
    const resolve = (source: typeof input.base, id: string, side: "base" | "candidate") => {
      if (quotes) {
        const original = chunk[side], prefix = side === "base" ? `b${chunk.baseDigest}:0` : `c${chunk.candidateDigest}:${chunk.candidateId}`;
        const range = generationQuoteRanges(original, prefix, quotes).find(r => r.id === id);
        const claim = range && original.claims.find(c => c.claimNo === range.claimNo);
        if (range && claim) return { claimNo: range.claimNo, quote: claim.text.slice(range.start, range.end) };
      }
      for (const claim of source.claims) {
        const segment = claim.segments.find(s => s.id === id);
        if (segment?.quotable) return { claimNo: claim.claimNo, quote: segment.text };
      }
      throw Error();
    };
    return { results: parsed.results.map(r => ({
      baseClaimNo: r.baseClaimNo, candidateClaimNo: r.candidateClaimNo,
      common: r.common, differences: r.differences, unconfirmed: r.unconfirmed,
      baseEvidence: resolve(input.base, r.baseEvidenceId, "base"),
      candidateEvidence: resolve(input.candidate, r.candidateEvidenceId, "candidate"),
    })) };
  } catch { throw new ComparisonError("ai_incomplete"); }
}
