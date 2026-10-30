import type { SourceReadingClaim } from "./source-clause-coverage";
import { resolveSourceContextQuote } from "./source-direct-quotes";
import { SOURCE_CAPACITY } from "./source-capacity";
import { sourceCellRef } from "./source-citation-grid";
import { decodeClaimCoordinateQuotes } from "./source-claim-coordinates";

const invalid = () => new Error("comparison_source_quotation_invalid");
const MAX_QUOTE_CODE_UNITS = 12_000;

/** The model supplies the unchanged quote and all disambiguating context.
 * Resolve that complete literal once against this claim only. After validation,
 * the established coordinate decoder projects the proven exact span into its
 * internal locator representation. Raw strings remain unchanged in the answer.
 * Context identifies an occurrence; it is not additional semantic evidence. */
export function decodeClaimQuotationQuotes(c: SourceReadingClaim, value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > SOURCE_CAPACITY.quotes ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > SOURCE_CAPACITY.wireBytes) throw invalid();
  const ids = new Set<string>(), spans = new Set<string>();
  const encoded = value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== 4 ||
        !["id", "quote", "before", "after"].every(key => Object.hasOwn(entry, key))) throw invalid();
    const { id, quote, before, after } = entry as {
      id: unknown; quote: unknown; before: unknown; after: unknown;
    };
    if (typeof id !== "string" || !/^q[0-9]{1,4}$/u.test(id) || ids.has(id) ||
        typeof quote !== "string" || !quote.length || quote.length > MAX_QUOTE_CODE_UNITS ||
        typeof before !== "string" || before.length > MAX_QUOTE_CODE_UNITS ||
        typeof after !== "string" || after.length > MAX_QUOTE_CODE_UNITS) throw invalid();
    const span = resolveSourceContextQuote(c.grid.text, { quote, before, after, edge: "none" });
    const key = span.join(":");
    if (spans.has(key)) throw invalid();
    ids.add(id); spans.add(key);
    // Bound the entire supplied context, even though only the selected quote
    // can provide semantic evidence. No invalid literal/context is repaired.
    const contextStart = span[0] - before.length, contextEnd = span[1] + after.length;
    const clauses = c.clauses.flatMap(([a, b], i) => a < contextEnd && b > contextStart ? [i] : []);
    if (!clauses.length || clauses.length > 12) throw invalid();
    const first = clauses[0], last = clauses.at(-1)!;
    if (contextStart < c.clauses[first][0] || contextEnd > c.clauses[last][1]) throw invalid();
    return { id, K: sourceCellRef(c.grid, span) };
  });
  // A projection of a successfully proven occurrence, not a fallback for a
  // failed quote. Its clause bounds cover the quote alone, so long supplied
  // context cannot inflate clause coverage. The raw model answer is untouched.
  const result = decodeClaimCoordinateQuotes(c, encoded);
  result.forEach((entry, i) => {
    if ((entry as { quote: unknown }).quote !== (value[i] as { quote: unknown }).quote) throw invalid();
  });
  return result;
}
