import {expect,it}from"vitest";
import{sourceReadingClaim}from"./source-clause-coverage";
import{resolveClaimLiteralReference,claimLiteralDictionary,mapClaimLiteralFact}from"./source-claim-literal-refs";
const c=sourceReadingClaim(1,"青管と青管、😀を黒管へ流す。");
const text=(v:unknown)=>c.grid.text.slice(...resolveClaimLiteralReference(c,v));
it("selects explicit same-clause repeated and overlapping occurrences",()=>{
 expect(text("0-0#0:青管")).toBe("青管");expect(resolveClaimLiteralReference(c,"0-0#1:青管")).not.toEqual(resolveClaimLiteralReference(c,"0-0#0:青管"));
 const x=sourceReadingClaim(1,"aaaa。");expect(resolveClaimLiteralReference(x,"0-0#1:aa")).toEqual([1,3]);expect(resolveClaimLiteralReference(x,"0-0#2:aa")).toEqual([2,4]);
});
it("preserves exact Unicode, cross-clause text, whitespace and colon punctuation",()=>{
 expect(text("0-1#0:青管、😀を黒管")).toBe("青管、😀を黒管");
 const x=sourceReadingClaim(1,"😀: é、端。"),r="0-0#0:😀: é";expect(x.grid.text.slice(...resolveClaimLiteralReference(x,r))).toBe("😀: é");
 expect(()=>resolveClaimLiteralReference(x,"0-0#0:😀: é")).toThrow();expect(()=>resolveClaimLiteralReference(x,"0-0#0:\ud83d")).toThrow();
});
it.each(["0-0:青管","0-0#2:青管","0-0#-1:青管","0-0#0:","1-0#0:青管","0-3#0:青管","00-0#0:青管","0-0#0.5:青管","0-0#9007199254740992:青管","0-0#0:前記青管","0-0#0:青管黒管"])("rejects unsupported or nonliteral reference %s",v=>expect(()=>text(v)).toThrow());
it("limits references to the explicit claim and12clauses without nearest selection",()=>{
 const x=sourceReadingClaim(1,"青、".repeat(12)+"黒。");expect(()=>resolveClaimLiteralReference(x,"0-11#0:"+"青、".repeat(12))).not.toThrow();expect(()=>resolveClaimLiteralReference(x,"0-12#0:黒")).toThrow();expect(()=>resolveClaimLiteralReference(x,"0-0#0:黒")).toThrow();
});
it("interns identical spans across different explicit ranges and maps every known citation role",()=>{
 const d=claimLiteralDictionary(c),one="0-0#0:青管",alias="0-1#0:青管",two="0-0#1:青管",r={m:{u:[one],i:[two],j:[one],G:[[one]],M:[[two]],V:[[one]],B:[[two]],J:[[one]],a:alias,k:"path"},O:[one,null,alias,two,one],F:{E:one,X:two,T:alias,C:[one,null],D:[two]}};
 const before=JSON.stringify(r),mapped=mapClaimLiteralFact(r,d);expect(JSON.stringify(r)).toBe(before);expect(d.quotes()).toHaveLength(2);expect((mapped.m as {a:string}).a).toBe("q0");expect(mapped.F).toEqual({E:"q0",X:"q1",T:"q0",C:["q0",null],D:["q1"]});expect(mapped.O).toEqual(["q0",null,"q0","q1","q0"]);
});
it("retains unknown fields for strict rejection and never treats old qIDs as references",()=>{
 const d=claimLiteralDictionary(c),row={m:{k:"relation",a:"0-0#0:青管",extra:"not-discarded"},O:[null,null,null,null,null],F:null,unknown:17};expect(mapClaimLiteralFact(row,d)).toHaveProperty("unknown",17);expect((mapClaimLiteralFact(row,d).m as Record<string,unknown>).extra).toBe("not-discarded");expect(()=>mapClaimLiteralFact({...row,m:{a:"q0"}},d)).toThrow();expect(()=>mapClaimLiteralFact({...row,F:{E:null,X:null,T:null,C:[],D:[],extra:1}},d)).toThrow();
});
