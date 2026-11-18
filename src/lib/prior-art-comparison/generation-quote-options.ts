import type { ManagedClaimSet, ManagedComparisonChunk } from "../patent-watch/managed-claims";
import type { DecodedSources } from "./proposition-extraction";
import { ComparisonError, digest } from "./source";
import { SOURCE_CAPACITY } from "./source-capacity";
import type { Span } from "./propositions";

export type GenerationQuoteRange = Readonly<{ id: string; claimNo: number; start: number; end: number }>;
export type GenerationQuoteOptions = Readonly<Record<string, Readonly<{ version: string; publicationNumber: string; claimHashes: Readonly<Record<number, string>>; ranges: readonly GenerationQuoteRange[] }>>>;
const sealed = new WeakMap<object, string>();
const quoteSets = new WeakSet<object>();
/** Decoder-only provenance: later mutation of actions, guards or originals is
 * rejected before these fallible citations become generation quote options. */
export function sealGenerationQuoteSource<T extends DecodedSources>(value: T): T {
  sealed.set(value, digest(value)); return value;
}
const invalid = () => new ComparisonError("ai_incomplete");
const prefixFor = (c: ManagedComparisonChunk, side: "base" | "candidate") => side === "base" ? `b${c.baseDigest}:0` : `c${c.candidateDigest}:${c.candidateId}`;

/** Covers the maximum extra numeric range transport and escaped enum IDs before
 * the first source request. No source fact or original is discarded to fit. */
export function generationQuoteAllowance(chunks: readonly ManagedComparisonChunk[]): number {
  const sources = new Map<string, ManagedClaimSet>();
  for (const chunk of chunks) for (const side of ["base", "candidate"] as const) {
    const prefix = prefixFor(chunk, side), prior = sources.get(prefix), source = chunk[side];
    sources.set(prefix, prior ? { ...source, claims: [...new Map([...prior.claims, ...source.claims].map(c => [c.claimNo, c])).values()] } : source);
  }
  return [...sources].reduce((bytes, [prefix, source]) => {
    const positionDigits = Math.max(...source.claims.map(c => String(c.text.length).length));
    const claimDigits = Math.max(...source.claims.map(c => String(c.claimNo).length));
    // One enum ID (quotes+comma) plus one escaped-prompt numeric [start,end]
    // range (brackets+commas). Existing originals/segment IDs are counted by
    // the ordinary request measurement; 32/claim covers new field framing.
    const idBytes = Math.min(100, prefix.length + claimDigits + 2 * positionDigits + 3);
    return bytes + SOURCE_CAPACITY.facts * (idBytes + 3 + 2 * positionDigits + 4) + source.claims.length * 32;
  }, 0);
}

/** The source decoder already validated these fallible citations. This helper
 * binds them again to the CURRENT originals and preserves every character
 * between their positions. It does not infer, repair or certify a meaning. */
export function generationQuoteOptions(chunks: readonly ManagedComparisonChunk[], decoded: DecodedSources): GenerationQuoteOptions {
  if (sealed.get(decoded) !== digest(decoded)) throw invalid();
  const expected = [{ side: "base" as const, docId: null, parts: chunks.map(c => c.base), selected: [...new Set(chunks.flatMap(c => c.pairs.map(p => p.baseClaimNo)))] },
    ...[...new Set(chunks.map(c => c.candidateId))].map(docId => ({ side: "candidate" as const, docId,
      parts: chunks.filter(c => c.candidateId === docId).map(c => c.candidate), selected: [...new Set(chunks.filter(c => c.candidateId === docId).flatMap(c => c.pairs.map(p => p.candidateClaimNo)))] }))];
  if (decoded.input.sources.length !== expected.length) throw invalid();
  const sources = expected.map((e, index) => {
    const first = e.parts[0], claims = new Map<number, ManagedClaimSet["claims"][number]>();
    for (const source of e.parts) {
      if (source.version !== first.version || source.publicationNumber !== first.publicationNumber) throw invalid();
      for (const claim of source.claims) {
        if (claims.has(claim.claimNo) && digest(claims.get(claim.claimNo)) !== digest(claim)) throw invalid();
        claims.set(claim.claimNo, claim);
      }
    }
    const original = { ...first, claims: [...claims.values()].sort((a, b) => a.claimNo - b.claimNo) }, source = decoded.input.sources[index];
    if (source.side !== e.side || source.docId !== e.docId || source.sourceDigest !== digest({ side: e.side, docId: e.docId, source: original, selected: e.selected })) throw invalid();
    const restored = { publicationNumber: source.source.publicationNumber, version: source.source.version,
      claims: source.source.claims.map(({ segments, ...c }) => ({ ...c, text: segments.map(s => s.text).join("") })) };
    if (digest(restored) !== digest(original)) throw invalid();
    return { source, original, ranges: [] as { claimNo: number; start: number; end: number }[] };
  });
  const seen = new Set<string>();
  for (const locator of decoded.locators) {
    const match = /^s(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(locator.id);
    if (!match || seen.has(locator.id)) throw invalid();
    seen.add(locator.id);
    const owner = sources[Number(match[1])]; if (!owner) throw invalid();
    const facts = decoded.facts.filter(f => f.id === locator.id && f.authority === "extracted");
    if (!facts.length || facts.some(f => f.claimNo !== facts[0].claimNo || !owner.source.scopes.some(s => s.id === f.scope))) throw invalid();
    const claim = owner.original.claims.find(c => c.claimNo === facts[0].claimNo); if (!claim) throw invalid();
    const spans: Span[] = [...locator.quotes, ...(locator.action ? [locator.action] : [])];
    if (!spans.length) continue;
    for (const [start, end] of spans) {
      const splits = (at: number) => at > 0 && at < claim.text.length && /[\uD800-\uDBFF]/u.test(claim.text[at - 1]) && /[\uDC00-\uDFFF]/u.test(claim.text[at]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > claim.text.length || splits(start) || splits(end)) throw invalid();
    }
    const start = Math.min(...spans.map(s => s[0])), end = Math.max(...spans.map(s => s[1])), quote = claim.text.slice(start, end);
    // A long/nonunique envelope cannot be shortened into a complete quote.
    if (end - start > 120 || !quote.trim() || claim.text.indexOf(quote) !== start || claim.text.indexOf(quote, start + 1) !== -1) continue;
    owner.ranges.push({ claimNo: claim.claimNo, start, end });
  }
  const result: Record<string, { version: string; publicationNumber: string; claimHashes: Readonly<Record<number, string>>; ranges: readonly GenerationQuoteRange[] }> = {};
  for (const chunk of chunks) for (const side of ["base", "candidate"] as const) {
    const owner = sources.find(s => s.source.side === side && (side === "base" || s.source.docId === chunk.candidateId))!;
    const prefix = prefixFor(chunk, side);
    const ranges = [...new Map(owner.ranges.map(r => [`${r.claimNo}:${r.start}:${r.end}`, r])).values()]
      .sort((a, b) => a.claimNo - b.claimNo || a.start - b.start || a.end - b.end)
      .map(r => Object.freeze({ ...r, id: `${prefix}:${r.claimNo}:${r.start}:${r.end}` }));
    if (ranges.length > SOURCE_CAPACITY.facts || ranges.some(r => r.id.length > 100)) throw invalid();
    const entry = Object.freeze({ version: owner.original.version, publicationNumber: owner.original.publicationNumber, claimHashes: Object.freeze(Object.fromEntries(owner.original.claims.map(c => [c.claimNo, digest(c)]))), ranges: Object.freeze(ranges) });
    if (result[prefix] && digest(result[prefix]) !== digest(entry)) throw invalid();
    result[prefix] = entry;
  }
  const immutable = Object.freeze(result); quoteSets.add(immutable); return immutable;
}

export function generationQuoteRanges(source: ManagedClaimSet, prefix: string, options: GenerationQuoteOptions): readonly GenerationQuoteRange[] {
  if (!quoteSets.has(options)) throw invalid();
  const entry = options[prefix];
  if (!entry || entry.version !== source.version || entry.publicationNumber !== source.publicationNumber ||
    source.claims.some(c => entry.claimHashes[c.claimNo] !== digest(c))) throw invalid();
  return entry.ranges.filter(r => source.claims.some(c => c.claimNo === r.claimNo));
}
