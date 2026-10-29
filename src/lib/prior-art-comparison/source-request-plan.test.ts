import { expect, it } from "vitest";
import { jsonSchema, type JSONSchema7 } from "ai";
import { sourceRequestPlan, sourceRequestPieces } from "./source-request-plan";
import type { SourceClaimTask } from "./source-claim-extraction";

const task = (claimNo: number, overrides: Partial<SourceClaimTask> = {}): SourceClaimTask => ({
  id: `fictional:${claimNo}`, sourceIndex: 0, sourceDigest: "fictional", claimNo,
  partitioned: false, compactBatchEligible: true, system: "fictional instructions",
  prompt: JSON.stringify({ task: "extract_source_propositions", citationClauses: {version:20},
    target: {sourceDigest:"fictional",claimNo}, sourceContext: {original:"Unchanged fictional original"} }),
  schema: jsonSchema({type:"object",properties:{claimNo:{type:"number",const:claimNo}},required:["claimNo"],additionalProperties:false}, {
    validate: raw => raw && typeof raw === "object" && Object.keys(raw).join() === "claimNo" &&
      (raw as {claimNo:unknown}).claimNo === claimNo ? {success:true,value:raw} : {success:false,error:new Error("claim mismatch")}
  }), ...overrides
});

it("plans pairs left to right using original identities and preserves singleton bytes", async () => {
  const tasks=[task(1),task(2),task(3)],requests=sourceRequestPlan({tasks});
  expect(requests.map(r=>r.tasks.map(t=>t.id))).toEqual([["fictional:1","fictional:2"],["fictional:3"]]);
  for(const k of ["system","prompt","schema","outputTokenLimit"] as const)expect(requests[1][k]).toBe(tasks[2][k]);
  const raw={first:{claimNo:1},second:{claimNo:2}},before=JSON.stringify(raw);
  expect(await sourceRequestPieces(requests[0],raw)).toEqual([{taskId:tasks[0].id,value:raw.first},{taskId:tasks[1].id,value:raw.second}]);
  expect(JSON.stringify(raw)).toBe(before);expect(requests[0].outputTokenLimit).toBe(22528);
});

it.each([
  {second:{claimNo:2}}, {first:{claimNo:1}}, {first:{claimNo:1},second:{claimNo:2},extra:{}},
  {first:{claimNo:2},second:{claimNo:1}}, {first:{claimNo:1},second:{claimNo:3}},
  {first:{claimNo:1},second:{claimNo:2,extra:true}}
])("rejects the entire pair with no partial projection for %j",async raw=>{
  const [request]=sourceRequestPlan({tasks:[task(1),task(2)]});
  await expect(sourceRequestPieces(request,raw)).rejects.toThrow();
});

it.each([
  {compactBatchEligible:false}, {partitioned:true}, {sourceIndex:1}, {sourceDigest:"other"}, {claimNo:3}, {system:"other"}
])("keeps incompatible adjacent tasks separate: %j",override=>{
  const requests=sourceRequestPlan({tasks:[task(1),task(2,override)]});expect(requests).toHaveLength(2);
});

it("namespaces changed definitions and their transitive parents while sharing identical leaves",()=>{
  const withDefs=(n:number)=>task(n,{schema:jsonSchema({type:"object",properties:{value:{$ref:"#/definitions/Parent"}},
    required:["value"],additionalProperties:false,definitions:{
      Parent:{type:"object",properties:{value:{$ref:"#/definitions/Choice"},common:{$ref:"#/definitions/Common"}}},
      Choice:{type:"string",const:String(n)},Common:{type:"string"}
    }})});
  const [request]=sourceRequestPlan({tasks:[withDefs(1),withDefs(2)]});
  const schema=request.schema.jsonSchema as JSONSchema7,defs=schema.definitions!;
  expect(Object.keys(defs).sort()).toEqual(["Common","member0_Choice","member0_Parent","member1_Choice","member1_Parent"]);
  expect((defs.member0_Parent as JSONSchema7).properties?.value).toEqual({$ref:"#/definitions/member0_Choice"});
  expect((defs.member1_Parent as JSONSchema7).properties?.common).toEqual({$ref:"#/definitions/Common"});
  expect(((schema.properties?.first as JSONSchema7).properties?.value)).toEqual({$ref:"#/definitions/member0_Parent"});
});
