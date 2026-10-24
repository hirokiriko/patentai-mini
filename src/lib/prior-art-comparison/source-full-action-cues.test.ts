import {expect,it} from "vitest";
import {sourceReadingClaim} from "./source-clause-coverage";
import {assertSourceSemanticReading,sourceFullActionCues} from "./source-semantic-check";
const cues=(text:string)=>sourceFullActionCues(sourceReadingClaim(1,text));
it("requires each printed component function independently of heat and possession",()=>{
 const text="冷媒を圧縮する圧縮器と、冷媒を減圧する減圧器と、空気を加熱する加熱器と、空気を冷却する冷却器と、温度を検出して信号を出力する検出器と、空気が流通する通路。";
 expect(cues(text).filter(c=>c.predicate==="executes").map(c=>text.slice(...c.span))).toEqual(["圧縮する","減圧する","加熱する","冷却する","検出して","出力する","流通する"]);
 const c=sourceReadingClaim(1,text);expect(()=>assertSourceSemanticReading(c,[],sourceFullActionCues(c))).toThrow("comparison_source_semantic_incomplete");
});
it.each(["冷媒を圧縮しない。","冷媒を減圧していなかった。","温度を検出することはない。","信号を出力せず、停止する。"])("preserves the full printed negation: %s",text=>{
 const found=cues(text).filter(c=>c.predicate==="executes");expect(found).toHaveLength(1);expect(found[0].polarity).toBe("negative");expect(text.slice(...found[0].span)).toMatch(/ない|なかった|ず/u);
});
it.each(["圧縮器と減圧器と加熱器と検出器。","冷媒を圧縮した後に停止する。","温度を検出する場合、赤弁を閉じる。","空気を冷却する必要がない。","信号を出力していれば停止する。","冷却することを禁止する。","加熱するものではない。","出力するのであれば、停止する。","出力してはならない。","冷却してしまう場合、赤弁を閉じる。","検出して出力する場合、赤弁を閉じる。"])("does not turn nouns or premises into asserted functions: %s",text=>{
 expect(cues(text).filter(c=>c.predicate==="executes")).toEqual([]);
});
