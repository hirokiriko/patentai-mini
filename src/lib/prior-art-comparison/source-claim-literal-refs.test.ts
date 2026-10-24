import {expect,it}from"vitest";
import{sourceReadingClaim}from"./source-clause-coverage";
import{resolveClaimLiteralReference,claimLiteralDictionary,mapClaimLiteralFact}from"./source-claim-literal-refs";
const c=sourceReadingClaim(1,"青管と青管、😀を黒管へ流す。"),focused=(reference:string,focus:string)=>({reference,focus});
const text=(v:unknown)=>c.grid.text.slice(...resolveClaimLiteralReference(c,v));
it("selects only unique exact outer and inner text, retaining the selected occurrence",()=>{
 expect(()=>text("0-0:青管")).toThrow();expect(resolveClaimLiteralReference(c,focused("0-0:青管と","青管"))).toEqual([0,2]);expect(resolveClaimLiteralReference(c,focused("0-0:と青管","青管"))).toEqual([3,5]);expect(text(focused("0-0:と青管","と青管"))).toBe("と青管");
});
it("keeps locator-only context outside the semantic span and reuses the exact internal quote",()=>{
 const x=sourceReadingClaim(1,"青管と及び青管にて流す。"),outer=focused("0-0:及び青管にて","青管"),span=resolveClaimLiteralReference(x,outer);expect(span).toEqual([5,7]);expect(x.grid.text.slice(...span)).toBe("青管");const d=claimLiteralDictionary(x);expect(d.reference(outer)).toBe(d.reference(focused("0-0:青管にて","青管")));
 expect(JSON.stringify(d.quotes())).not.toContain("及び");
});
it("preserves exact Unicode, combining marks, whitespace, colon and cross-clause focus",()=>{
 const x=sourceReadingClaim(1,"😀: é、青管。"),v=focused("0-1:😀: é、青管","é、青管");expect(x.grid.text.slice(...resolveClaimLiteralReference(x,v))).toBe("é、青管");expect(()=>resolveClaimLiteralReference(x,focused("0-1:😀: é、青管","é、青管"))).toThrow();expect(()=>resolveClaimLiteralReference(x,focused("0-0:😀: é","\ud83d"))).toThrow();expect(()=>resolveClaimLiteralReference(x,"0-0:\ud83d")).toThrow();
});
it.each(["0-0#0:青管","0-0#1:青管","0-0:","1-0:青管","0-3:青管","00-0:青管","0-9007199254740992:青管","0-0:前記青管","0-0:青管黒管"])("rejects unsupported or nonliteral reference %s",v=>expect(()=>text(v)).toThrow());
it("rejects ambiguous outer even when focus could select one and ambiguous overlapping inner",()=>{
 expect(()=>text(focused("0-0:青管","青"))).toThrow();expect(()=>text(focused("0-0:青管と青管","青管"))).toThrow();const x=sourceReadingClaim(1,"aaaa。");expect(()=>resolveClaimLiteralReference(x,focused("0-0:aaaa","aa"))).toThrow();expect(()=>resolveClaimLiteralReference(x,focused("0-0:aaaa","a"))).toThrow();
 const repeated=sourceReadingClaim(1,"管管管");for(const outer of ["管","管管","管管管"])expect(()=>resolveClaimLiteralReference(repeated,focused(`0-0:${outer}`,"管"))).toThrow();
});
it("rejects false, empty, outside, normalized, noncontiguous and oversized focus",()=>{
 for(const v of [focused("0-0:と青管","黒管"),focused("0-0:と青管",""),focused("0-0:と青管","と管"),focused("0-0:と青管","x".repeat(12001)),focused("0-0:"+"x".repeat(12001),"x"),focused("0-0:不存在","青管")])expect(()=>text(v)).toThrow();
});
it("rejects old context objects/tuples and unknown or malformed object fields",()=>{
 for(const v of [{reference:"0-0:と青管",before:"",after:""},["0-0:青管","と",""],{reference:"0-0:と青管",focus:"青管",extra:1},{reference:3,focus:"青管"},{reference:"0-0:と青管",focus:3},{focus:"青管"}])expect(()=>text(v)).toThrow();
});
it("limits outer references to this claim and twelve clauses without nearest selection",()=>{
 const x=sourceReadingClaim(1,"青、".repeat(12)+"黒。");expect(()=>resolveClaimLiteralReference(x,focused("0-11:"+"青、".repeat(12),"青"))).toThrow();expect(()=>resolveClaimLiteralReference(x,"0-11:"+"青、".repeat(12))).not.toThrow();expect(()=>resolveClaimLiteralReference(x,focused("0-12:黒","黒"))).toThrow();expect(()=>resolveClaimLiteralReference(x,focused("0-0:青、","黒"))).toThrow();
});
it("interns only selected spans and maps every citation-bearing role without mutating raw",()=>{
 const d=claimLiteralDictionary(c),one=focused("0-0:青管と","青管"),alias=focused("0-1:青管と","青管"),two=focused("0-0:と青管","青管"),r={m:{u:[one],i:[two],j:[one],G:[[one]],M:[[two]],V:[[one]],B:[[two]],J:[[one]],a:alias,k:"path"},O:[one,null,alias,two,one],F:{E:one,X:two,T:alias,C:[one,null],D:[two]}};
 const before=JSON.stringify(r),mapped=mapClaimLiteralFact(r,d);expect(JSON.stringify(r)).toBe(before);expect(d.quotes()).toHaveLength(2);expect((mapped.m as {a:string}).a).toBe("q0");expect(mapped.F).toEqual({E:"q0",X:"q1",T:"q0",C:["q0",null],D:["q1"]});expect(mapped.O).toEqual(["q0",null,"q0","q1","q0"]);
});
it("retains unknown fields for unchanged strict rejection and rejects qIDs",()=>{
 const d=claimLiteralDictionary(c),row={m:{k:"relation",a:focused("0-0:青管と","青管"),extra:"not-discarded"},O:[null,null,null,null,null],F:null,unknown:17};expect(mapClaimLiteralFact(row,d)).toHaveProperty("unknown",17);expect((mapClaimLiteralFact(row,d).m as Record<string,unknown>).extra).toBe("not-discarded");expect(()=>mapClaimLiteralFact({...row,m:{a:"q0"}},d)).toThrow();
});
