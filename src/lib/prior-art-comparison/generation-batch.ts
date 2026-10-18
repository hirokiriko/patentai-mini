import { z } from "zod";
import { managedClaimContext, type ManagedClaimSet, type ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { assertGenerationEvidence, generationInput, generationSchema } from "./generation";
import { LIMITS } from "./limits";
import { ComparisonError } from "./source";
import { referenceLogicInput } from "./reference-logic";
import { sourceAnalysisInput, type SourceAnalysis } from "./source-analysis";
import { literalStructureInput } from "./literal-structure";

// Combine only identical source versions; claim text is never summarized.
export function unionSource(sources: readonly ManagedClaimSet[]): ManagedClaimSet {
  const first = sources[0];
  if (!first || sources.some(s => s.version !== first.version || s.publicationNumber !== first.publicationNumber)) throw new ComparisonError("selection_invalid");
  const claims = new Map<number, ManagedClaimSet["claims"][number]>();
  for (const source of sources) for (const claim of source.claims) {
    if (claims.has(claim.claimNo) && JSON.stringify(claims.get(claim.claimNo)) !== JSON.stringify(claim)) throw new ComparisonError("selection_invalid");
    claims.set(claim.claimNo, claim);
  }
  return { ...first, claims: [...claims.values()].sort((a, b) => a.claimNo - b.claimNo) };
}

export function batchInput(chunks: readonly ManagedComparisonChunk[], sourceAnalysis: SourceAnalysis = []) {
  const base = unionSource(chunks.map(c => c.base));
  return { task: "compare" as const,
    sourceDigests: sourceAnalysisInput(chunks).sources.map(s => s.sourceDigest),
    sourceAnalysis,
    base: { ...generationInput({ ...chunks[0], base }).base,
      ...literalStructureInput(base),
      referenceLogic: referenceLogicInput(base, [...new Set(chunks.flatMap(c => c.pairs.map(p => p.baseClaimNo)))]) },
    documents: chunks.map(chunk => {
      const d = generationInput(chunk);
      return { candidateId: d.candidateId, baseDigest: d.baseDigest, candidateDigest: d.candidateDigest, pairs: d.pairs, candidate: d.candidate };
    }),
  };
}
const resultSchema = generationSchema.shape.results.element.extend({ docId: z.number().int().positive() });
export const batchSchema = z.object({ results: z.array(resultSchema).min(1).max(LIMITS.reviewPairs) }).strict();
export type BatchAnswer = z.infer<typeof batchSchema>;

export function batchSchemaFor(chunks: readonly ManagedComparisonChunk[]) {
  const input = batchInput(chunks);
  const ids = (sources: (typeof input.base)[]) => [...new Set(sources.flatMap(s => s.claims.flatMap(c => c.segments.filter(s => s.quotable).map(s => s.id))))];
  const base = ids([input.base]), candidate = ids(input.documents.map(d => d.candidate));
  if (base.length + candidate.length > 1000 || [base, candidate].some(v => v.length > 250 && v.join("").length > 15000)) throw new ComparisonError("plan_limit");
  return batchSchema.extend({ results: z.array(resultSchema.extend({ baseEvidenceId: z.enum(base), candidateEvidenceId: z.enum(candidate) })).min(1).max(LIMITS.reviewPairs) });
}
/** Non-quotable parts retain every character and their order. Their long IDs
 * cannot appear in the output enum, so omit only that redundant metadata. */
export function batchTransportInput(chunks: readonly ManagedComparisonChunk[], sourceAnalysis: SourceAnalysis = []) {
  const input = batchInput(chunks, sourceAnalysis);
  const compact = (source: typeof input.base) => ({ ...source, claims: source.claims.map(c => ({ ...c,
    segments: c.segments.map(s => s.quotable ? s : { text: s.text, quotable: false as const }) })) });
  return { ...input, base: compact(input.base), documents: input.documents.map(d => ({ ...d, candidate: compact(d.candidate) })) };
}
export function requestBytes(system: string, prompt: string, schema: z.ZodType): number {
  return Buffer.byteLength(JSON.stringify({ system, prompt, schema: z.toJSONSchema(schema) }), "utf8") + 8192;
}

/** Pack up to four planned pairs. Execution distributes the complete answer
 * back to the original two-pair decoder chunks. */
export function generationBatches(plan: readonly ManagedComparisonChunk[], system: string): ManagedComparisonChunk[][] {
  const singles = plan.flatMap(c => c.pairs.map(p => ({ ...c, pairs: [p], base: managedClaimContext(c.base, [p.baseClaimNo]), candidate: managedClaimContext(c.candidate, [p.candidateClaimNo]) })));
  if (!singles.length || singles.length > LIMITS.reviewPairs) throw new ComparisonError("plan_limit");
  for (const c of singles) assertGenerationEvidence(c);
  const combine = (parts: ManagedComparisonChunk[]) => {
    const byDocument = new Map<number, ManagedComparisonChunk[]>();
    for (const c of parts) byDocument.set(c.candidateId, [...(byDocument.get(c.candidateId) ?? []), c]);
    return [...byDocument.values()].map(cs => ({ ...cs[0], pairs: cs.flatMap(c => c.pairs), base: unionSource(cs.map(c => c.base)), candidate: unionSource(cs.map(c => c.candidate)) }));
  };
  const fits = (batch: ManagedComparisonChunk[]) => {
    try { return requestBytes(system, JSON.stringify(batchTransportInput(batch)), batchSchemaFor(batch)) <= LIMITS.inputBytes; }
    catch (e) { if (e instanceof ComparisonError && e.code === "plan_limit") return false; throw e; }
  };
  const batches: ManagedComparisonChunk[][] = [];
  for (let at = 0; at < singles.length;) {
    let take = Math.min(LIMITS.reviewPairs, singles.length - at);
    let batch = combine(singles.slice(at, at + take));
    while (take > 1 && !fits(batch)) { take--; batch = combine(singles.slice(at, at + take)); }
    if (!fits(batch)) throw new ComparisonError("plan_limit");
    batches.push(batch); at += take;
  }
  if (batches.length + 1 > LIMITS.calls) throw new ComparisonError("plan_limit");
  return batches;
}
