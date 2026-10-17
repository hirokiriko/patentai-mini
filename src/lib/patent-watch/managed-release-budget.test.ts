import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { managedReleaseBudgetRequest, managedReleaseStepSchema } from "./managed-budget-evidence";
import { emptyManagedBudgetUnits } from "./managed-service-budget";
import { managedDigest } from "./managed-claims";
const hash="a".repeat(64),sha="a".repeat(40);
function step(){return {issue:129,repository:"hirokiriko/patentai-mini",operationId:randomUUID(),kind:"validation",trigger:"pr-push",
  prNumber:130,targetRef:"refs/heads/codex/issue-129-test",remoteBeforeSha:"b".repeat(40),headSha:sha,baseSha:"c".repeat(40),treeSha:"d".repeat(40),
  ciWorkflowSha256:hash,deployWorkflowSha256:"b".repeat(64),preflightDigest:"c".repeat(64),pricingDigest:"d".repeat(64),reservationYen:115};}
it("keeps the pushed branch's previous SHA separate from main and binds every trigger field",()=>{
  const value=step(),request=managedReleaseBudgetRequest(value,hash,hash);
  expect(request).toMatchObject({kind:"validation",scope:"release",profileDigest:null,cases:[],reservationYen:115,units:emptyManagedBudgetUnits()});
  for(const patch of [{remoteBeforeSha:"e".repeat(40)},{headSha:"e".repeat(40)},{baseSha:"e".repeat(40)},
    {treeSha:"e".repeat(40)},{ciWorkflowSha256:"e".repeat(64)},{deployWorkflowSha256:"e".repeat(64)},
    {prNumber:131},{targetRef:"refs/heads/codex/another"},{trigger:"pr-reopen"}]){
    expect(managedReleaseBudgetRequest({...value,...patch},hash,hash).requestDigest).not.toBe(request.requestDigest);
  }
});
it.each(["forward","rollback"])("derives only the %s counter from a reviewed main operation",kind=>{
  const value={...step(),kind,trigger:"squash-merge",targetRef:"refs/heads/main"};value.remoteBeforeSha=value.baseSha;
  expect(managedReleaseBudgetRequest(value,hash,hash).units).toEqual({...emptyManagedBudgetUnits(),[kind]:1});
});
it("reserves the first branch push before a PR exists, then separately reserves opening it",()=>{
  const value={...step(),prNumber:null,remoteBeforeSha:null};
  const first=managedReleaseBudgetRequest(value,hash,hash);
  expect(first.kind).toBe("validation");
  expect(managedReleaseBudgetRequest({...value,remoteBeforeSha:"e".repeat(40)},hash,hash).requestDigest).not.toBe(first.requestDigest);
  const open={...value,operationId:randomUUID(),trigger:"pr-open",remoteBeforeSha:sha};
  expect(managedReleaseBudgetRequest(open,hash,hash).requestDigest).not.toBe(first.requestDigest);
  expect(()=>managedReleaseStepSchema.parse({...value,trigger:"pr-reopen"})).toThrow();
  expect(()=>managedReleaseStepSchema.parse({...open,remoteBeforeSha:null})).toThrow();
});
it.each([{repository:"other/repository"},{issue:128},{kind:"watch"},{trigger:"squash-merge"},{targetRef:"refs/heads/main"},
  {units:emptyManagedBudgetUnits()},{reservationYen:0},{reservationYen:30001},{targetRef:"refs/heads/codex//bad"},
  {trigger:"workflow-dispatch"},{trigger:"pr-open"}])("rejects a mismatched or caller-controlled release field %#",patch=>{
  expect(()=>managedReleaseStepSchema.parse({...step(),...patch})).toThrow();
});
it("admits an exact main dispatch but rejects using a PR candidate as its current main SHA",()=>{
  const value={...step(),kind:"rollback",trigger:"workflow-dispatch",targetRef:"refs/heads/main",prNumber:null,remoteBeforeSha:sha,baseSha:sha};
  expect(managedReleaseStepSchema.parse(value)).toEqual(value);
  expect(()=>managedReleaseStepSchema.parse({...value,headSha:"e".repeat(40)})).toThrow();
});
function issue150Step() { return { ...step(), issue: 150, kind: "forward", trigger: "squash-merge", prNumber: 151,
  targetRef: "refs/heads/main", remoteBeforeSha: "c".repeat(40), issue150Integration: {
    scope: "ISSUE150_INTEGRATION_V1", ownerApprovalDigest: hash, profileDigest: "e".repeat(64),
    approvedAt: "2026-10-17T06:41:40Z", validUntil: "2026-10-18T06:41:40Z", forwardOperationId: null } }; }
it("preserves old canonical requests and binds Issue150's ordinary authority separately", () => {
  const old = step(), r = managedReleaseBudgetRequest(old, hash, hash);
  expect(managedReleaseStepSchema.parse(old)).toEqual(old);
  expect(r.requestDigest).toBe(managedDigest({ schema: 1, purpose: "MANAGED_WATCH_RELEASE_STEP_V1", targetBindingHash: hash, ownerBindingHash: hash, step: old }));
  const s = issue150Step(), current = managedReleaseBudgetRequest(s, hash, hash);
  expect(current).toMatchObject({ scope: "standard", profileDigest: s.issue150Integration.profileDigest,
    units: { ...emptyManagedBudgetUnits(), forward: 1 } });
  for (const patch of [{ profileDigest: hash }, { ownerApprovalDigest: "f".repeat(64) }])
    expect(managedReleaseBudgetRequest({ ...s, issue150Integration: { ...s.issue150Integration, ...patch } }, hash, hash).requestDigest).not.toBe(current.requestDigest);
});
it.each(["missing", "other-issue", "dispatch", "forward-pointer", "expiry", "approval-time", "completion-borrow", "unbounded-field"])(
  "rejects invalid Issue150 authority: %s", reason => {
    const s = issue150Step();
    if (reason === "missing") Reflect.deleteProperty(s, "issue150Integration");
    if (reason === "other-issue") s.issue = 129;
    if (reason === "dispatch") Object.assign(s, { trigger: "workflow-dispatch", prNumber: null, headSha: s.baseSha });
    if (reason === "forward-pointer") Object.assign(s.issue150Integration, { forwardOperationId: randomUUID() });
    if (reason === "expiry") s.issue150Integration.validUntil = "2026-10-19T06:41:40Z";
    if (reason === "approval-time") s.issue150Integration.approvedAt = "2026-10-18T06:41:40Z";
    if (reason === "completion-borrow") Object.assign(s, { completionAllowance: {} });
    if (reason === "unbounded-field") Object.assign(s.issue150Integration, { forward: 10 });
    expect(() => managedReleaseStepSchema.parse(s)).toThrow();
  });
