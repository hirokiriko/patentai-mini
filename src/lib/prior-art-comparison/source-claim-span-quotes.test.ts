import {expect,it} from "vitest";
import {sourceReadingClaim} from "./source-clause-coverage";
import {decodeClaimSpanQuotes} from "./source-claim-span-quotes";
const c=sourceReadingClaim(1,"青管と青管、😀の黒管へ流す。");
const decode=(Q:unknown)=>decodeClaimSpanQuotes(c,Q) as {id:string;quote:string;first:number;last:number}[];
it("selects repeated original occurrences without generating or searching quotation text",()=>{
 const raw=[{id:"q0",S:[0,0,0,2]},{id:"q1",S:[0,3,0,5]}],before=JSON.stringify(raw);
 expect(decode(raw).map(q=>q.quote)).toEqual(["青管","青管"]);expect(JSON.stringify(raw)).toBe(before);
});
it("counts Unicode scalars rather than UTF16 units and preserves spaces and punctuation",()=>{
 expect(decode([{id:"q0",S:[1,0,1,1]}])[0].quote).toBe("😀");
 const x=sourceReadingClaim(1,"a 😀、é 。");
 expect((decodeClaimSpanQuotes(x,[{id:"q0",S:[0,1,1,3]}]) as {quote:string}[])[0].quote).toBe(" 😀、é ");
});
it("permits an exact cross-clause original slice, never inserted connectors",()=>{
 expect(decode([{id:"q0",S:[0,3,1,2]}])[0].quote).toBe("青管、😀の");
});
it.each([[0,0,0,0],[0,2,0,1],[0,6,0,6],[1,0,0,1],[0,0,2,1],[0,-1,0,1],[0,0,0,1.5],[0,0,0,99],[0,0,1,0]])("rejects invalid boundaries %j",S=>{
 expect(()=>decode([{id:"q0",S}])).toThrow();
});
it("rejects old literal/K formats, extra fields, duplicate IDs or spans",()=>{
 for(const q of [[{id:"q0",quote:"青管",clause:0}],[{id:"q0",K:[0,0,0,1]}],[{id:"q0",S:[0,0,0,2],quote:"別管"}],[{id:"q0",S:[0,0,0,2]},{id:"q0",S:[0,3,0,5]}],[{id:"q0",S:[0,0,0,2]},{id:"q1",S:[0,0,0,2]}],[{id:"q0a",S:[0,0,0,2]}]])expect(()=>decode(q)).toThrow();
});
it("retains at most12 original clauses and every valid scalar boundary",()=>{
 const x=sourceReadingClaim(1,"青、".repeat(12)+"黒。");
 expect(()=>decodeClaimSpanQuotes(x,[{id:"q0",S:[0,0,11,2]}])).not.toThrow();
 expect(()=>decodeClaimSpanQuotes(x,[{id:"q0",S:[0,0,12,1]}])).toThrow();
 for(let start=0;start<5;start++)for(let end=start+1;end<=6;end++)expect(decode([{id:"q0",S:[0,start,0,end]}])[0].quote).toBe(Array.from(c.grid.text.slice(...c.clauses[0])).slice(start,end).join(""));
});
