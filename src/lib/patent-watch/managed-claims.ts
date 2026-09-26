import { createHash } from "node:crypto";
import { z } from "zod";

/** Internal only: never expose these texts/digests in reports, URLs or logs. */
export type ManagedClaim = Readonly<{ claimNo: number; text: string; dependsOn: readonly number[] }>;
export type ManagedClaimSet = Readonly<{
  publicationNumber: string;
  version: string;
  claims: readonly ManagedClaim[];
}>;
export class ManagedClaimsError extends Error {
  constructor(readonly code: "claims_missing" | "claims_invalid" | "reference_missing" | "coverage_invalid" | "split_limit") { super(code); }
}
const MAX_CLAIMS = 1_000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MANAGED_DETAIL_LIMIT = 40;
// Leaves space for SDK framing, system prompt, schema and the guard's 8,192 reserve.
export const MANAGED_CHUNK_BYTES = 90_000;
// Finite output capacity; no cross-document/claim truncation to fit the output.
const MAX_PAIRS_PER_CHUNK = 12;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export const managedDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateManagedClaims(source: ManagedClaimSet): void {
  if (!source || typeof source.publicationNumber !== "string" || !source.publicationNumber.trim() || source.publicationNumber.length > 100 ||
      typeof source.version !== "string" || !source.version.trim() || source.version.length > 100 ||
      !Array.isArray(source.claims) || source.claims.length === 0) throw new ManagedClaimsError("claims_missing");
  if (source.claims.length > MAX_CLAIMS) throw new ManagedClaimsError("split_limit");
  if (Object.keys(source).some(k => !["publicationNumber", "version", "claims"].includes(k))) throw new ManagedClaimsError("claims_invalid");
  const claims = new Map<number, ManagedClaim>();
  let bytes = 0;
  for (const claim of source.claims) {
    if (!claim || !positive(claim.claimNo) || claims.has(claim.claimNo) || typeof claim.text !== "string" || !claim.text.trim() ||
        !Array.isArray(claim.dependsOn) || claim.dependsOn.length > MAX_CLAIMS || claim.dependsOn.some((n: number) => !positive(n)) ||
        new Set(claim.dependsOn).size !== claim.dependsOn.length) throw new ManagedClaimsError("claims_invalid");
    if (Object.keys(claim).some(k => !["claimNo", "text", "dependsOn"].includes(k))) throw new ManagedClaimsError("claims_invalid");
    bytes += Buffer.byteLength(claim.text, "utf8");
    if (bytes > MAX_SOURCE_BYTES) throw new ManagedClaimsError("split_limit");
    claims.set(claim.claimNo, claim);
  }
  // Iterative DFS avoids a caller-controlled recursion stack and rejects cycles.
  const complete = new Set<number>();
  for (const root of claims.keys()) {
    const visiting = new Set<number>();
    const stack: Array<{ no: number; exit: boolean }> = [{ no: root, exit: false }];
    while (stack.length) {
      const { no, exit } = stack.pop()!;
      if (exit) { visiting.delete(no); complete.add(no); continue; }
      if (visiting.has(no)) throw new ManagedClaimsError("reference_missing");
      if (complete.has(no)) continue;
      const claim = claims.get(no);
      if (!claim) throw new ManagedClaimsError("reference_missing");
      visiting.add(no); stack.push({ no, exit: true });
      for (const ref of claim.dependsOn) stack.push({ no: ref, exit: false });
    }
  }
}
function copySource(source: ManagedClaimSet, claims = source.claims): ManagedClaimSet {
  return Object.freeze({ publicationNumber: source.publicationNumber, version: source.version,
    claims: Object.freeze(claims.map(c => Object.freeze({ claimNo: c.claimNo, text: c.text, dependsOn: Object.freeze([...c.dependsOn]) }))) });
}
function closure(source: ManagedClaimSet, selected: readonly number[]): ManagedClaim[] {
  const claims = new Map(source.claims.map(c => [c.claimNo, c]));
  const included = new Set<number>();
  const stack = [...selected];
  while (stack.length) {
    const no = stack.pop()!;
    if (included.has(no)) continue;
    const claim = claims.get(no);
    if (!claim) throw new ManagedClaimsError("reference_missing");
    included.add(no); stack.push(...claim.dependsOn);
  }
  return source.claims.filter(c => included.has(c.claimNo));
}
export type ManagedPair = Readonly<{ baseClaimNo: number; candidateClaimNo: number }>;
export function managedClaimContext(source: ManagedClaimSet, selected: readonly number[]): ManagedClaimSet {
  validateManagedClaims(source);
  return copySource(source, closure(source, selected));
}
export type ManagedComparisonChunk = Readonly<{
  candidateId: number;
  base: ManagedClaimSet;
  candidate: ManagedClaimSet;
  pairs: readonly ManagedPair[];
  baseDigest: string;
  candidateDigest: string;
}>;
export type ManagedComparisonPlan = Readonly<{
  digest: string;
  selectedClaimNos: readonly number[];
  chunks: readonly ManagedComparisonChunk[];
}>;
export function planManagedComparisons(base: ManagedClaimSet, selected: readonly number[],
  candidates: readonly { candidateId: number; source: ManagedClaimSet }[]): ManagedComparisonPlan {
  validateManagedClaims(base);
  base = copySource(base);
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_CLAIMS || new Set(selected).size !== selected.length || selected.some(no => !positive(no))) {
    throw new ManagedClaimsError("claims_invalid");
  }
  closure(base, selected);
  if (candidates.length > 20 || new Set(candidates.map(c => c.candidateId)).size !== candidates.length || candidates.some(c => !positive(c.candidateId))) {
    throw new ManagedClaimsError("coverage_invalid");
  }
  const baseDigest = managedDigest(base);
  const chunks: ManagedComparisonChunk[] = [];
  for (const entry of candidates) {
    validateManagedClaims(entry.source);
    const candidateDigest = managedDigest(entry.source);
    const make = (pairs: ManagedPair[]): ManagedComparisonChunk => Object.freeze({
      candidateId: entry.candidateId, baseDigest, candidateDigest, pairs: Object.freeze(pairs.map(p => Object.freeze({ ...p }))),
      base: copySource(base, closure(base, pairs.map(p => p.baseClaimNo))),
      candidate: copySource(entry.source, closure(entry.source, pairs.map(p => p.candidateClaimNo))),
    });
    let pairs: ManagedPair[] = [];
    const flush = () => {
      if (pairs.length) { chunks.push(make(pairs)); pairs = []; }
      if (chunks.length > MANAGED_DETAIL_LIMIT) throw new ManagedClaimsError("split_limit");
    };
    for (const baseClaimNo of selected) for (const claim of entry.source.claims) {
      const pair = { baseClaimNo, candidateClaimNo: claim.claimNo };
      const proposed = [...pairs, pair];
      if (proposed.length > MAX_PAIRS_PER_CHUNK || Buffer.byteLength(JSON.stringify(make(proposed)), "utf8") > MANAGED_CHUNK_BYTES) flush();
      pairs.push(pair);
      if (Buffer.byteLength(JSON.stringify(make(pairs)), "utf8") > MANAGED_CHUNK_BYTES) throw new ManagedClaimsError("split_limit");
    }
    flush();
  }
  const selectedClaimNos = Object.freeze([...selected]);
  return Object.freeze({ digest: managedDigest({ selectedClaimNos, chunks }), selectedClaimNos, chunks: Object.freeze(chunks) });
}

// Exact bounded quote is internal validation only. Reports project claim number/positions.
const position = z.object({ claimNo: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  quote: z.string().min(1).max(300) }).strict();
const score = z.number().min(0).max(1);
export const managedComparisonSchema = z.object({ results: z.array(z.object({
  baseClaimNo: z.number().int().positive(), candidateClaimNo: z.number().int().positive(),
  lexicalScore: score, elementScore: score, semanticScore: score, structuralScore: score,
  riskLabel: z.enum(["High", "Medium", "Low", "Unknown"]),
  baseEvidence: position, candidateEvidence: position,
  explanation: z.string().min(1).max(1_500),
}).strict()).max(MAX_PAIRS_PER_CHUNK) }).strict();
export type ManagedComparison = z.infer<typeof managedComparisonSchema>["results"][number];
/** Every requested pair exactly once; quoted locations must exist in the exact input. */
export function validateManagedComparisons(chunk: ManagedComparisonChunk, value: unknown): ManagedComparison[] {
  const parsed = managedComparisonSchema.safeParse(value);
  if (!parsed.success) throw new ManagedClaimsError("coverage_invalid");
  const key = (p: ManagedPair) => `${p.baseClaimNo}:${p.candidateClaimNo}`;
  const expected = new Set(chunk.pairs.map(key));
  const seen = new Set<string>();
  const validateEvidence = (source: ManagedClaimSet, no: number, evidence: z.infer<typeof position>) => {
    const allowed = closure(source, [no]);
    const claim = allowed.find(c => c.claimNo === evidence.claimNo);
    const splitsSurrogate = (at: number) => claim && at > 0 && at < claim.text.length &&
      /[\uD800-\uDBFF]/.test(claim.text[at - 1]) && /[\uDC00-\uDFFF]/.test(claim.text[at]);
    if (!claim || evidence.start >= evidence.end || evidence.end > claim.text.length || !evidence.quote.trim() ||
        claim.text.slice(evidence.start, evidence.end) !== evidence.quote || splitsSurrogate(evidence.start) || splitsSurrogate(evidence.end)) {
      throw new ManagedClaimsError("coverage_invalid");
    }
  };
  for (const result of parsed.data.results) {
    const id = key(result);
    if (!expected.has(id) || seen.has(id)) throw new ManagedClaimsError("coverage_invalid");
    seen.add(id);
    validateEvidence(chunk.base, result.baseClaimNo, result.baseEvidence);
    validateEvidence(chunk.candidate, result.candidateClaimNo, result.candidateEvidence);
  }
  if (seen.size !== expected.size) throw new ManagedClaimsError("coverage_invalid");
  return parsed.data.results;
}
