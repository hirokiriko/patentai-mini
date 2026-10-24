import {expect,it} from "vitest";
import {compactSourceWitness,compactRuntimeSourceWitness,expandSourceWitness,
  compactSourceDescriptorTable,expandSourceDescriptorTable} from "./proposition-witness";
import type {SourceExtraction} from "./proposition-extraction";
function fixture():SourceExtraction{
  return {sources:[{sourceDigest:"a".repeat(64),facts:[1,2].flatMap(claimNo=>["has","opens","power_ends"].map(predicate=>({
    claimNo,basis:[[0,20]],meaning:{subject:null,kind:"relation",context:"capability",guard:{relation:"unconditional",conditions:[]},
      polarity:"positive",predicate:predicate as "has"|"opens"|"power_ends",objects:["弁"]},bindings:[{term:"弁",spans:[[2,3]]}],
    operators:{selection:null,extent:null,polarity:null,guard:null,context:null},routeFrame:null})))}]};
}
it("preserves old v1 and complete v2 fields including new predicates",()=>{
  const raw=fixture(),original=JSON.stringify(raw),old=compactSourceWitness(raw),current=compactRuntimeSourceWitness(raw);
  expect(expandSourceWitness(old)).toEqual(raw);expect(expandSourceWitness(current)).toEqual(raw);
  expect(JSON.stringify(raw)).toBe(original);
  expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(Buffer.byteLength(JSON.stringify(old)));
});
it.each(["unused_head","duplicate_head","split_run","even_run","zero_length","overflow","cross_claim","basis_array","null_operator_array","null_frame","extra_fact","head_index"])("rejects altered runtime v2 structure %s",mode=>{
  const w=compactRuntimeSourceWitness(fixture()),s=w.sources[0],f=s.facts[0];
  if(mode==="unused_head"||mode==="duplicate_head")s.heads.push(structuredClone(s.heads[0]));
  if(mode==="split_run"){const r=s.positions[0];s.positions.splice(0,1,[r[0],r[1],r[2]],[r[0],...r.slice(3)]);}
  if(mode==="even_run")s.positions[0].pop();
  if(mode==="zero_length")s.positions[0][2]=0;
  if(mode==="overflow")s.positions[0][1]=Number.MAX_SAFE_INTEGER;
  if(mode==="cross_claim")s.positions[0][0]=99;
  if(mode==="basis_array")f[1]=[f[1] as number];
  if(mode==="null_operator_array")f[4]=[null,null,null,null,null];
  if(mode==="null_frame")(f as unknown[]).push(null);
  if(mode==="extra_fact")(f as unknown[]).push(null,null);
  if(mode==="head_index")f[2][0]=99;
  expect(()=>expandSourceWitness(w)).toThrow();
});
it("preserves every descriptor field and rejects unused or corrupt dictionary entries",()=>{
  const raw=[{id:"s0.0",claimNo:1,basis:[[0,20] as [number,number]],kind:"relation" as const,subject:"甲"},
    {id:"s1.0",claimNo:2,basis:[[0,20] as [number,number]],kind:"path" as const,subject:null}];
  const table=compactSourceDescriptorTable(raw);expect(expandSourceDescriptorTable(table)).toEqual(raw);
  for(const mode of ["subject","basis","index","extra_row"]){
    const w=structuredClone(table);
    if(mode==="subject")w.subjects.push("未使用");if(mode==="basis")w.bases.push([[0,1]]);
    if(mode==="index")(w.rows[0] as unknown as unknown[])[2]=99;
    if(mode==="extra_row")(w.rows[0] as unknown as unknown[]).push(null);
    expect(()=>expandSourceDescriptorTable(w)).toThrow();
  }
});
