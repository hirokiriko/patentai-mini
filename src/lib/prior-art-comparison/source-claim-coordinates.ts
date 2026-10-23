import { resolveSourceCellRef } from "./source-citation-grid";
import type { SourceReadingClaim } from "./source-clause-coverage";
import { sourceIdentifiedQuoteDictionary } from "./source-reading-tasks";

const invalid = () => new Error("comparison_source_coordinate_invalid");

/** All-prefix LCPs in linear time, with a separator absent from Unicode text. */
function prefixMatches(prefix: readonly string[], text: readonly string[]): number[] {
  if (!prefix.length) return new Array<number>(text.length).fill(0);
  const sequence: (string | null)[] = [...prefix, null, ...text];
  const z = new Array<number>(sequence.length).fill(0);
  let left = 0, right = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]);
    while (i + z[i] < sequence.length && sequence[z[i]] === sequence[i + z[i]]) z[i]++;
    if (i + z[i] - 1 > right) { left = i; right = i + z[i] - 1; }
  }
  return z.slice(prefix.length + 1);
}

/** Coordinates are the sole model-supplied location. Context only serializes
 * that exact occurrence for the unchanged strict quote decoder. */
export function decodeClaimCoordinateQuotes(c: SourceReadingClaim, value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1024) throw invalid();
  const ids = new Set<string>(), spans = new Set<string>();
  const result = value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "id") || !Object.hasOwn(entry, "K")) throw invalid();
    const { id, K } = entry as { id: unknown; K: unknown };
    if (typeof id !== "string" || !/^q[0-9]{1,4}$/u.test(id) || ids.has(id)) throw invalid();
    const span = resolveSourceCellRef(c.grid, K), key = span.join(":");
    if (spans.has(key)) throw invalid();
    ids.add(id); spans.add(key);
    const clauses = c.clauses.flatMap(([a, b], i) => a < span[1] && b > span[0] ? [i] : []);
    if (!clauses.length || clauses.length > 12) throw invalid();
    const first = clauses[0], last = clauses.at(-1)!;
    const start = c.clauses[first][0], end = c.clauses[last][1];
    if (span[0] < start || span[1] > end) throw invalid();
    const text = c.grid.text.slice(start, end), localStart = span[0] - start, localEnd = span[1] - start;
    const quote = text.slice(localStart, localEnd);
    const scalars = Array.from(text), boundaries = new Map<number, number>();
    let offset = 0;
    scalars.forEach((scalar, index) => { boundaries.set(offset, index); offset += scalar.length; });
    boundaries.set(offset, scalars.length);
    const begin = boundaries.get(localStart), finish = boundaries.get(localEnd);
    if (begin === undefined || finish === undefined) throw invalid();
    const left = scalars.slice(0, begin).reverse(), right = scalars.slice(finish);
    const forward = prefixMatches(right, scalars), backward = prefixMatches(left, [...scalars].reverse());
    const quoted = scalars.slice(begin, finish), occurrences = prefixMatches(quoted, scalars);
    // Bucket competing occurrences by equal left-context length. Suffix maxima
    // then answer every candidate in O(1), rather than rescanning competitors.
    const bucket = new Array<number>(left.length + 1).fill(0);
    for (let at = 0; at < scalars.length; at++) {
      if (at === begin || occurrences[at] < quoted.length) continue;
      const l = at ? Math.min(left.length, backward[scalars.length - at]) : 0;
      const end = at + quoted.length;
      const r = end < scalars.length ? Math.min(right.length, forward[end]) : 0;
      bucket[l] = Math.max(bucket[l], r + 1);
    }
    const suffix = new Array<number>(bucket.length + 1).fill(0);
    for (let i = bucket.length - 1; i >= 0; i--) suffix[i] = Math.max(bucket[i], suffix[i + 1]);
    let best: { left: number; right: number } | undefined;
    // Only 0 and competitor.left+1 can improve a distinguishing context.
    for (let l = 0; l <= left.length; l++) {
      if (l && !bucket[l - 1]) continue;
      const r = suffix[l];
      if (r <= right.length && (!best || l + r < best.left + best.right)) best = { left: l, right: r };
    }
    if (!best) throw invalid();
    return { id, first, last, quote,
      before: left.slice(0, best.left).reverse().join(""), after: right.slice(0, best.right).join("") };
  });
  // Confirm the unchanged resolver identifies exactly the encoded locations.
  sourceIdentifiedQuoteDictionary(c, result);
  return result;
}
