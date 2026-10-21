import type { Span } from "./propositions";

export const SOURCE_GRID_COLUMNS = 10;
export type SourceCellRef = readonly [number, number, number, number];
export type SourceCitationGrid = { text: string; spans: Span[]; rows: string[] };
const invalid = () => new Error("comparison_locator_invalid");
function displayCell(char: string): string {
  return /[|\\\s\p{Mark}\p{Control}\p{Format}]/u.test(char)
    ? `\\u{${char.codePointAt(0)!.toString(16)}}` : char;
}
/** Cells preserve every Unicode scalar and occurrence in the entire claim.
 * Storage parts, words, grammar and semantic roles never determine cell IDs. */
export function sourceCitationGrid(text: string): SourceCitationGrid {
  const spans: Span[] = [], cells: string[] = [];
  let offset = 0;
  for (const char of text) {
    if (char.length === 1 && /[\uD800-\uDFFF]/u.test(char)) throw invalid();
    spans.push([offset, offset + char.length]); offset += char.length;
    cells.push(displayCell(char));
  }
  if (!cells.length) throw invalid();
  const rows: string[] = [];
  for (let at = 0; at < cells.length; at += SOURCE_GRID_COLUMNS)
    rows.push(`${at / SOURCE_GRID_COLUMNS}|${cells.slice(at, at + SOURCE_GRID_COLUMNS).join("|")}`);
  return { text, spans, rows };
}
/** Only identical display rows share their cell spelling. Every original row
 * ID is explicit, so repeats still have separate immutable coordinates. */
export function compactSourceGridRows(grid:SourceCitationGrid):string[] {
  const rows=new Map<string,number[]>();
  grid.rows.forEach((row,i)=>{
    const cells=row.slice(row.indexOf("|")+1),ids=rows.get(cells)??[];
    ids.push(i);rows.set(cells,ids);
  });
  return [...rows].map(([cells,ids])=>`${ids.join(",")}|${cells}`);
}
/** Inclusive endpoint cells become exact UTF16 positions. No text search,
 * nearest match, normalization, inferred occurrence or surrogate split. */
export function resolveSourceCellRef(grid: SourceCitationGrid, value: unknown): Span {
  if (!Array.isArray(value) || value.length !== 4 ||
      value.some(n => !Number.isSafeInteger(n) || n < 0) || value[1] >= 10 || value[3] >= 10) throw invalid();
  const first = value[0] * 10 + value[1], last = value[2] * 10 + value[3];
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || last >= grid.spans.length) throw invalid();
  return [grid.spans[first][0], grid.spans[last][1]];
}
/** Inverse for already located evidence, never for repairing a model answer. */
export function sourceCellRef(grid: SourceCitationGrid, span: Span): SourceCellRef {
  const first = grid.spans.findIndex(s => s[0] === span[0]), last = grid.spans.findIndex(s => s[1] === span[1]);
  if (first < 0 || last < first) throw invalid();
  return [Math.floor(first / 10), first % 10, Math.floor(last / 10), last % 10];
}
export const SOURCE_GRID_GUIDE = "Each claim grid line is rowIDs|column0|column1|...|column9 (last row may be shorter). Comma-separated rowIDs mean identical cells occur at EACH listed row, not one occurrence. Read all rows in numeric rowID order. Each cell is one original Unicode scalar; \\u{hex} displays exactly one original scalar. Join every cell, including spaces/repetitions, to read the complete claim. Rows are coordinates, NEVER semantic clauses. Every quote is [startRow,startColumn,endRow,endColumn], inclusive endpoints in that same claim. Select cells, never regenerate text or count UTF16 offsets. Cross-row references are allowed. Empty [] is whole-claim proof ONLY in operators/frames, never a term.";
