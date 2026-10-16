import { z } from "zod";
import { managedClaimContext, type ManagedClaimSet, type ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { ComparisonError } from "./source";

const claimNo = z.number().int().positive();
const text = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f-\x9f]*$/);
const evidenceId = z.string().min(1).max(100).regex(/^[bc][a-f0-9]{64}:\d+:\d+:\d+$/);
// Source observations precede comparison. They are bounded generation aids,
// not a second semantic validator or a change to the immutable saved format.
export const generationSchema = z.object({ results: z.array(z.object({
  baseClaimNo: claimNo, candidateClaimNo: claimNo,
  baseObservation: text.max(120), candidateObservation: text.max(120),
  common: text, differences: text, unconfirmed: text.max(120),
  baseEvidenceId: evidenceId, candidateEvidenceId: evidenceId,
}).strict()).min(1).max(2) }).strict();
export type GenerationAnswer = z.infer<typeof generationSchema>;
type Segment = { id: string; text: string; quotable: boolean };

function sourceSegments(source: ManagedClaimSet, prefix: string) {
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
export function generationInput(chunk: ManagedComparisonChunk) {
  return { ...chunk,
    pairs: chunk.pairs.map(pair => ({ ...pair,
      baseContextClaimNos: managedClaimContext(chunk.base, [pair.baseClaimNo]).claims.map(c => c.claimNo),
      candidateContextClaimNos: managedClaimContext(chunk.candidate, [pair.candidateClaimNo]).claims.map(c => c.claimNo),
    })),
    base: sourceSegments(chunk.base, `b${chunk.baseDigest}:0`),
    candidate: sourceSegments(chunk.candidate, `c${chunk.candidateDigest}:${chunk.candidateId}`),
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

export function generationSchemaFor(chunk: ManagedComparisonChunk) {
  const input = generationInput(chunk);
  const ids = (side: "base" | "candidate") => input[side].claims.flatMap(c => c.segments.filter(s => s.quotable).map(s => s.id));
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
export function decodeGeneration(chunk: ManagedComparisonChunk, answer: unknown) {
  try {
    const parsed = generationSchema.parse(answer);
    // Protocol metadata is not a patent condition or a reason that source text
    // cannot be compared. Apply this only to new generations, not saved readers.
    if (parsed.results.some(r => /quotable|(?:base|candidate)(?:EvidenceId|ContextClaimNos)/i.test(
      [r.baseObservation, r.candidateObservation, r.common, r.differences, r.unconfirmed].join("\n"),
    ))) throw Error();
    const input = generationInput(chunk);
    const resolve = (source: typeof input.base, id: string) => {
      for (const claim of source.claims) {
        const segment = claim.segments.find(s => s.id === id);
        if (segment?.quotable) return { claimNo: claim.claimNo, quote: segment.text };
      }
      throw Error();
    };
    return { results: parsed.results.map(r => ({
      baseClaimNo: r.baseClaimNo, candidateClaimNo: r.candidateClaimNo,
      common: r.common, differences: r.differences, unconfirmed: r.unconfirmed,
      baseEvidence: resolve(input.base, r.baseEvidenceId),
      candidateEvidence: resolve(input.candidate, r.candidateEvidenceId),
    })) };
  } catch { throw new ComparisonError("ai_incomplete"); }
}
