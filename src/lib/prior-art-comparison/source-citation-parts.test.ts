import {expect,it} from "vitest";
import {sourceCitationParts,sourceCitationPartIds,sourceCitationRange} from "./source-citation-parts";
it("preserves repeated parts, UTF16 and cross-part evidence without deduplication",()=>{
  const parts=sourceCitationParts(["青😀","同じ","同じ","赤"]);
  expect(parts).toEqual([[0,3],[3,5],[5,7],[7,8]]);
  expect(sourceCitationRange(parts,1,2)).toEqual([3,7]);
  expect(sourceCitationPartIds(parts,[4,8])).toEqual([1,3]);
  expect(sourceCitationPartIds(parts,[3,5])).toEqual([1,1]);
});
it.each([[-1,0],[2,1],[0,9],[0,0.5]])("rejects part range %j",(first,last)=>{
  expect(()=>sourceCitationRange(sourceCitationParts(["a","b"]),first,last)).toThrow();
});
