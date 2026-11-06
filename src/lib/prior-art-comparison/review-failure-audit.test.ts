import { expect, it } from "vitest";
import { ComparisonExecutionError } from "./failure";
import { retainReviewFailure, takeReviewFailure, validateReviewFailureEvidence, type ReviewFailureStep } from "./review-failure-audit";
import { appendReviewFailureAudit, sourceAudit, validateSourceAudit } from "./source-audit";
import { digest } from "./source";

const operationId="12345678-1234-4234-8234-123456789abc",inputDigest="a".repeat(64);
const task={id:"b".repeat(64)+":1",sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1};
function failure(step:ReviewFailureStep="assessment",review:unknown={targets:[{value:"PRIVATE_REVIEW"}]}) {
  const error=new ComparisonExecutionError("review","protocol_invalid");
  retainReviewFailure(error,{step,inputs:{inputDigest},selection:{inputDigest,operationId},
    generation:{results:[{value:"PRIVATE_GENERATION"}]},review});
  return error;
}
it.each(["assessment","coverage_render","final_answer","saved_envelope"] as const)("retains exact private replay inputs at %s without serializing them on the Error",step=>{
  const error=failure(step),captured=takeReviewFailure(error)!;
  expect(captured.step).toBe(step);
  expect(captured.review).toMatchObject({status:"captured",value:{targets:[{value:"PRIVATE_REVIEW"}]}});
  expect(validateReviewFailureEvidence(captured)).toEqual(captured);
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|generation|inputs|selection|reviewFailure/);
  expect(takeReviewFailure(error)).toBeUndefined();
});
it("retains an explicit fingerprint instead of truncating an oversized reply",()=>{
  const captured=takeReviewFailure(failure("assessment",{text:"x".repeat(64_001)}))!;
  expect(captured.review).toMatchObject({status:"omitted",reason:"size_limit"});
  expect(captured.review).not.toHaveProperty("value");
  expect(validateReviewFailureEvidence(captured)).toEqual(captured);
});
it("does not attach diagnostic model data to unknown transport/usage failures",()=>{
  const error=new ComparisonExecutionError("review","transport_unknown");
  retainReviewFailure(error,{step:"assessment",inputs:{},selection:{},generation:{},review:{}});
  expect(takeReviewFailure(error)).toBeUndefined();
});
it("keeps the complete original v1 audit and its digest inside a bounded v2 download",()=>{
  const original=sourceAudit(operationId,inputDigest,[task],[{taskId:task.id,value:{unchanged:"source"}}]);
  const before=JSON.stringify(original),captured=takeReviewFailure(failure())!;
  const next=appendReviewFailureAudit(original,captured);
  expect(next.version).toBe(2);expect(next.previousAuditDigest).toBe(original.auditDigest);
  expect(next.answers).toEqual(original.answers);expect(JSON.stringify(original)).toBe(before);
  expect(validateSourceAudit(original,operationId,inputDigest)).toEqual(original);
  expect(validateSourceAudit(JSON.parse(JSON.stringify(next)),operationId,inputDigest)).toEqual(next);
  expect(()=>appendReviewFailureAudit(next,captured)).toThrow("save_unconfirmed");
  for(const field of ["previousAuditDigest","reviewFailure"] as const) {
    const altered=structuredClone(next);delete altered[field];
    expect(()=>validateSourceAudit(altered,operationId,inputDigest)).toThrow("save_unconfirmed");
  }
  const altered=structuredClone(next);altered.previousAuditDigest="c".repeat(64);
  const {auditDigest:discard,...body}=altered;void discard;altered.auditDigest=digest(body);
  expect(()=>validateSourceAudit(altered,operationId,inputDigest)).toThrow("save_unconfirmed");
});
it("rejects forged captured bytes, extra metadata and a different operation binding",()=>{
  const captured=takeReviewFailure(failure())!;
  const forged=structuredClone(captured);forged.review.bytes++;
  expect(()=>validateReviewFailureEvidence(forged)).toThrow();
  expect(()=>validateReviewFailureEvidence({...captured,headers:{authorization:"PRIVATE"}})).toThrow();
  const error=new ComparisonExecutionError("review","protocol_invalid");
  retainReviewFailure(error,{step:"assessment",inputs:{inputDigest},selection:{inputDigest,operationId:"wrong"},generation:{},review:{}});
  const original=sourceAudit(operationId,inputDigest,[task],[{taskId:task.id,value:{unchanged:true}}]);
  expect(()=>appendReviewFailureAudit(original,takeReviewFailure(error)!)).toThrow("save_unconfirmed");
});
