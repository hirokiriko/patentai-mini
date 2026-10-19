import {expect,it} from "vitest";
import {sourceCitationParts,sourceCitationPartIds,sourceCitationRange,sourceCitationLocator} from "./source-citation-parts";
import {resolvePropositionQuote} from "./proposition-locators";
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

it.each([
  {texts:["送出器から送出器へ戻る"],span:[5,8],occurrence:1},
  {texts:["aaaaa"],span:[2,5],occurrence:2},
  {texts:["前記循環","器へ戻る"],span:[2,5],occurrence:0},
  {texts:["青😀","同じ","同じ","赤"],span:[5,7],occurrence:0},
])("round-trips an exact repeated or cross-part boundary: %j",({texts,span,occurrence})=>{
  const text=texts.join(""),parts=sourceCitationParts(texts),position=span as [number,number];
  const locator=sourceCitationLocator(text,parts,position);
  expect(locator.occurrence).toBe(occurrence);
  const [a,b]=sourceCitationRange(parts,locator.firstPart,locator.lastPart);
  expect(resolvePropositionQuote(text.slice(a,b),locator.quote,locator.occurrence).map(n=>n+a)).toEqual(position);
});
it.each([[-1,1],[1,1],[0,20],[0.5,2],[1,2],[2,3]])("rejects an invalid or split-surrogate boundary: %j",(start,end)=>{
  const text="青😀赤";
  expect(()=>sourceCitationLocator(text,sourceCitationParts([text]),[start,end])).toThrow();
});
