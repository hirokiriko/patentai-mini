import {expect,it}from"vitest";
import{sourceReadingClaim}from"./source-clause-coverage";
import{resolveClaimLiteralReference,claimLiteralDictionary,mapClaimLiteralFact}from"./source-claim-literal-refs";
const c=sourceReadingClaim(1,"青管と青管、😀を黒管へ流す。");
const ctx=(reference:string,before:string,after:string)=>({reference,before,after});
const text=(v:unknown)=>c.grid.text.slice(...resolveClaimLiteralReference(c,v));
it("requires uniqueness and exact adjacent context including overlapping matches",()=>{
 expect(()=>text("0-0:青管")).toThrow();
 expect(resolveClaimLiteralReference(c,ctx("0-0:青管","","と"))).toEqual([0,2]);
 expect(resolveClaimLiteralReference(c,ctx("0-0:青管","と",""))).toEqual([3,5]);
 const x=sourceReadingClaim(1,"aaaa。");expect(()=>resolveClaimLiteralReference(x,"0-0:aa")).toThrow();
 expect(resolveClaimLiteralReference(x,ctx("0-0:aa","aa","。")).map(Number)).toEqual([2,4]);
 expect(()=>resolveClaimLiteralReference(x,ctx("0-0:aa","a",""))).toThrow();
});
it("preserves exact Unicode, cross-clause text, whitespace and colon punctuation",()=>{
 expect(text("0-1:青管、😀を黒管")).toBe("青管、😀を黒管");
 const x=sourceReadingClaim(1,"😀: é、端。"),r="0-0:😀: é";expect(x.grid.text.slice(...resolveClaimLiteralReference(x,r))).toBe("😀: é");
 expect(()=>resolveClaimLiteralReference(x,"0-0:😀: é")).toThrow();expect(()=>resolveClaimLiteralReference(x,"0-0:\ud83d")).toThrow();
});
it.each(["0-0#0:青管","0-0#1:青管","0-0:","1-0:青管","0-3:青管","00-0:青管","0-9007199254740992:青管","0-0:前記青管","0-0:青管黒管"])("rejects unsupported or nonliteral reference %s",v=>expect(()=>text(v)).toThrow());
it("limits references to the explicit claim and12clauses without nearest selection",()=>{
 const x=sourceReadingClaim(1,"青、".repeat(12)+"黒。");expect(()=>resolveClaimLiteralReference(x,"0-11:"+"青、".repeat(12))).not.toThrow();expect(()=>resolveClaimLiteralReference(x,"0-12:黒")).toThrow();expect(()=>resolveClaimLiteralReference(x,"0-0:黒")).toThrow();
});
it("interns identical spans across different explicit ranges and maps every known citation role",()=>{
 const d=claimLiteralDictionary(c),one=ctx("0-0:青管","","と"),alias=ctx("0-1:青管","","と"),two=ctx("0-0:青管","と",""),r={m:{u:[one],i:[two],j:[one],G:[[one]],M:[[two]],V:[[one]],B:[[two]],J:[[one]],a:alias,k:"path"},O:[one,null,alias,two,one],F:{E:one,X:two,T:alias,C:[one,null],D:[two]}};
 const before=JSON.stringify(r),mapped=mapClaimLiteralFact(r,d);expect(JSON.stringify(r)).toBe(before);expect(d.quotes()).toHaveLength(2);expect((mapped.m as {a:string}).a).toBe("q0");expect(mapped.F).toEqual({E:"q0",X:"q1",T:"q0",C:["q0",null],D:["q1"]});expect(mapped.O).toEqual(["q0",null,"q0","q1","q0"]);
});
it("retains unknown fields for strict rejection and never treats old qIDs as references",()=>{
 const d=claimLiteralDictionary(c),row={m:{k:"relation",a:ctx("0-0:青管","","と"),extra:"not-discarded"},O:[null,null,null,null,null],F:null,unknown:17};expect(mapClaimLiteralFact(row,d)).toHaveProperty("unknown",17);expect((mapClaimLiteralFact(row,d).m as Record<string,unknown>).extra).toBe("not-discarded");expect(()=>mapClaimLiteralFact({...row,m:{a:"q0"}},d)).toThrow();expect(()=>mapClaimLiteralFact({...row,F:{E:null,X:null,T:null,C:[],D:[],extra:1}},d)).toThrow();
});

it("rejects malformed, outside-range, oversized and broken Unicode context",()=>{
 const x=sourceReadingClaim(1,"😀青、黒青。");
 for(const v of [ctx("0-1:青","😀青、",""),ctx("0-0:青","", "、黒"),ctx("0-1:青","\ud83d", "、"),ctx("0-1:青","\ude00","、"),{reference:"0-1:青",before:3,after:""},ctx("0-1:青","x".repeat(12001),""),ctx("0-1:青","","x".repeat(12001))])expect(()=>resolveClaimLiteralReference(x,v)).toThrow();
 const bounded=sourceReadingClaim(1,"青青、黒青。");expect(()=>resolveClaimLiteralReference(bounded,ctx("0-0:青","黒","。"))).toThrow();
 const high=sourceReadingClaim(1,"青😀、青黒。");expect(()=>resolveClaimLiteralReference(high,ctx("0-1:青","","\ud83d"))).toThrow();
 expect(resolveClaimLiteralReference(x,ctx("0-1:青","😀","、"))).toEqual([2,3]);
 expect(()=>resolveClaimLiteralReference(x,"0-1:"+"x".repeat(12001))).toThrow();
});
it("distinguishes prefix variants without adding or normalizing prefixes",()=>{
 const x=sourceReadingClaim(1,"前記青管と該青管と青管。");
 expect(()=>resolveClaimLiteralReference(x,"0-0:青管")).toThrow();
 expect(x.grid.text.slice(...resolveClaimLiteralReference(x,ctx("0-0:青管","該","と")))).toBe("青管");
 expect(()=>resolveClaimLiteralReference(x,ctx("0-0:青管","当該","と"))).toThrow();
});

it("accepts exact context for a unique quote without ignoring supplied context or accepting historical tuples",()=>{
 const x=sourceReadingClaim(1,"前記圧縮機と赤管。");expect(resolveClaimLiteralReference(x,"0-0:前記圧縮機")).toEqual([0,5]);
 expect(resolveClaimLiteralReference(x,ctx("0-0:前記圧縮機","","と"))).toEqual([0,5]);
 const mode=sourceReadingClaim(1,"循環させる冬モードと、冷やす夏モード。");
 expect(resolveClaimLiteralReference(mode,ctx("0-0:冬モード","る","と"))).toEqual(resolveClaimLiteralReference(mode,"0-0:冬モード"));
 for(const v of [ctx("0-0:前記圧縮機","記","と"),ctx("0-0:前記圧縮機","\u0000","と"),ctx("0-0:前記圧縮機","","赤"),["0-0:前記圧縮機","","と"],{reference:"0-0:前記圧縮機",before:"",after:"と",extra:true}])expect(()=>resolveClaimLiteralReference(x,v)).toThrow();
});
it("never drops incorrect outside context even when quote matches several times",()=>{
 const x=sourceReadingClaim(1,"前記青管と前記青管。");expect(resolveClaimLiteralReference(x,ctx("0-0:前記青管","と","。"))).toEqual([5,9]);
 for(const v of [ctx("0-0:前記青管","記","と"),ctx("0-0:前記青管","\u0000","と"),ctx("0-0:前記青管","",""),ctx("0-0:前記青管","と","x"),["0-0:前記青管","と","。"]])expect(()=>resolveClaimLiteralReference(x,v)).toThrow();
});
