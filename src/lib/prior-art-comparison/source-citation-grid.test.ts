import { expect, it } from "vitest";
import { sourceCitationGrid, compactSourceGridRows, sourceCellRef, resolveSourceCellRef } from "./source-citation-grid";
import { fixtureGridText } from "../../../scripts/prior-art-grid-fixture.mjs";

it("shares only identical display rows while preserving every long-claim occurrence and its coordinates",()=>{
  const text="反復😀e\u0301|\\\t。".repeat(1700)+"末尾の異なる語。",original=sourceCitationGrid(text);
  const rows=compactSourceGridRows(original);
  expect(fixtureGridText({grid:rows})).toBe(text);
  const ids=rows.flatMap(row=>row.split("|")[0].split(",").map(Number)).sort((a,b)=>a-b);
  expect(ids).toEqual(original.rows.map((_,i)=>i));
  expect(rows.length).toBeLessThan(original.rows.length/10);
  const tail=text.lastIndexOf("反復");
  expect(resolveSourceCellRef(original,sourceCellRef(original,[tail,tail+2]))).toEqual([tail,tail+2]);
});

it("retains repeated occurrences, row boundaries and every Unicode scalar without storage-part dependence", () => {
  const text = "弁を開く。弁を開く。😀e\u0301 葛\u{e0100}|\\\r\n\t\u202e";
  const grid = sourceCitationGrid(text);
  expect(grid.spans.map(s=>text.slice(...s)).join("")).toBe(text);
  expect(grid.spans.length).toBe(Array.from(text).length);
  for (let a=0;a<grid.spans.length;a++) for(let b=a;b<grid.spans.length;b++) {
    const span:[number,number]=[grid.spans[a][0],grid.spans[b][1]];
    expect(resolveSourceCellRef(grid,sourceCellRef(grid,span))).toEqual(span);
  }
  expect(resolveSourceCellRef(grid,[0,0,0,0])).toEqual([0,1]);
  expect(resolveSourceCellRef(grid,[0,5,0,5])).toEqual([5,6]);
  expect(grid.rows.join("\n")).toContain("\\u{7c}");
  expect(grid.rows.join("\n")).toContain("\\u{301}");
  expect(grid.rows.join("\n")).toContain("\\u{e0100}");
});
it.each([[],[0,0],[0,0,0,0,0],[-1,0,0,0],[0,10,0,10],[0,0,0,9],
  [0,1,0,0],[0,0.5,0,1],[Number.MAX_SAFE_INTEGER,0,Number.MAX_SAFE_INTEGER,0],null,"0,0,0,0"])("rejects invalid cell selection %j", value => {
  expect(()=>resolveSourceCellRef(sourceCitationGrid("短文"),value)).toThrow("comparison_locator_invalid");
});
it.each(["", "\ud800", "a\udfff", "\ud800x"])("rejects empty or malformed scalar input", text => {
  expect(()=>sourceCitationGrid(text)).toThrow("comparison_locator_invalid");
});
it("never accepts an inverse span inside a surrogate pair",()=>{
  const grid=sourceCitationGrid("A😀B");
  expect(()=>sourceCellRef(grid,[1,2])).toThrow();
  expect(()=>sourceCellRef(grid,[2,3])).toThrow();
  expect(resolveSourceCellRef(grid,[0,1,0,1])).toEqual([1,3]);
});
