import { afterEach, expect, it, vi } from "vitest";
import { fictionalSaved } from "./fixtures.test-support";
import { digest } from "./source";
import { sourceAudit } from "./source-audit";
import { savedDigest } from "./comparison";
import { heldReservationEvidence, type HeldRow } from "./held-reservation";
import { assertReleaseHistory, historicalHeldReference, readLimitedRelease, LIMITED_RELEASE_ENV, type LimitedRelease } from "./limited-release";
const OLD="a0000000-0000-4000-8000-000000000001", HELD="a0000000-0000-4000-8000-000000000002", DEV="a0000000-0000-4000-8000-000000000003", DAY="a0000000-0000-4000-8000-000000000004";
function fixture(){
  const saved=fictionalSaved();saved.inputs.caseId=104;saved.operationId=DEV;saved.selection.operationId=DEV;saved.snapshotDigest=savedDigest(saved);
  const {operationId:ignored,...scope}=saved.selection;void ignored;
  const heldSelection={...scope,operationId:HELD},oldSelection={...scope,operationId:OLD};
  const make=(selection:typeof heldSelection,firstId:number,failure?:{stage:"generation";kind:"protocol_invalid"},audit?:unknown):HeldRow[]=>scope.documents.map((doc,i)=>({resultId:firstId+i,caseId:104,draftClaimId:String(scope.draftClaimNos[0]),priorDocId:doc.docId,matchedElementsJson:JSON.stringify({priorArtComparison:{version:1,status:"reserved",operationId:selection.operationId,selection,...(failure?{failure}:{})},...(audit?{priorArtComparisonSourceAudit:audit}:{})})}));
  const audit=sourceAudit(OLD,scope.inputDigest,[{id:"b".repeat(64)+":1",sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1}],[]);
  const failure={stage:"generation" as const,kind:"protocol_invalid" as const};
  const heldRows=make(heldSelection,31),oldRows=make(oldSelection,21,failure,audit),rows=[...oldRows,...heldRows];
  const reference={operationId:HELD,selection:heldSelection,selectionSHA256:digest(heldSelection)},evidence=heldReservationEvidence(rows,reference),now=Date.now();
  const release:LimitedRelease={schema:"CASE104_LIMITED_RELEASE_V2",caseId:104,phase:"dev",activeOperationId:DEV,devOperationId:DEV,validFromUTC:new Date(now-1000).toISOString(),validUntilUTC:new Date(now+60000).toISOString(),authority:{sequence:170,envelopeSHA256:"c".repeat(64),ownerDecisionSHA256:"d".repeat(64)},scope,oldFailure:{operationId:OLD,selectionSHA256:digest(oldSelection),auditDigest:audit.auditDigest,...failure},retainedUnknown:{evidence,isolationEvidenceSHA256:"e".repeat(64)},budget:{maximumSends:8,maximumJPY:500,inputYenPer100k:7,outputYenPer100k:19}};
  return {release,rows,heldRows,reference,evidence,saved,make,failure};
}
afterEach(()=>vi.unstubAllEnvs());
function continuedFixture() {
  const f = fixture();
  const operationId = "a0000000-0000-4000-8000-000000000005";
  const selection = { ...f.release.scope, operationId };
  const task = { id: "b".repeat(64) + ":1", sourceIndex: 0, sourceDigest: "b".repeat(64), claimNo: 1 };
  const audit = sourceAudit(operationId, selection.inputDigest, [task], []);
  const additionalFailure = { operationId, selectionSHA256: digest(selection), auditDigest: audit.auditDigest, ...f.failure };
  const release = { ...f.release, schema: "CASE104_LIMITED_RELEASE_V3" as const,
    authority: { ...f.release.authority, sequence: 172 as const }, additionalFailure };
  return { ...f, release, additionalRows: f.make(selection, 41, f.failure, audit) };
}
function twoHeldFixture() {
  const f = continuedFixture();
  const operationId = "a0000000-0000-4000-8000-000000000006";
  const selection = { ...f.release.scope, operationId };
  const reference = { operationId, selection, selectionSHA256: digest(selection) };
  const rows = [...f.rows, ...f.additionalRows, ...f.make(selection, 51)];
  const evidence = heldReservationEvidence(rows, reference);
  const release = { ...f.release, schema: "CASE104_LIMITED_RELEASE_V4" as const,
    authority: { ...f.release.authority, sequence: 174 as const },
    additionalUnknown: { evidence, isolationEvidenceSHA256: "f".repeat(64) } };
  return { ...f, release, rows, secondReference: reference };
}
it("V4 binds both held fingerprints and terminal failures throughout development and practitioner use", () => {
  const f = twoHeldFixture();
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(f.release));
  expect(readLimitedRelease().value).toEqual(f.release);
  expect(historicalHeldReference(104, HELD)).toEqual(f.reference);
  expect(historicalHeldReference(104, f.secondReference.operationId)).toEqual(f.secondReference);
  expect(() => historicalHeldReference(104, DEV)).toThrow();
  const original = JSON.stringify(f.rows);
  assertReleaseHistory(f.release, f.rows, []);
  const day = { ...f.release, phase: "day" as const, activeOperationId: DAY, devSavedSnapshotDigest: f.saved.snapshotDigest };
  assertReleaseHistory(day, f.rows, [f.saved]);
  expect(() => assertReleaseHistory(day, f.rows, [])).toThrow();
  expect(JSON.stringify(f.rows)).toBe(original);
  for (const index of [0, 2, 4, 6, 7]) {
    const changed = f.rows.map((row, i) => i === index ? { ...row, matchedElementsJson: null } : row);
    expect(() => assertReleaseHistory(f.release, changed, [])).toThrow();
    expect(() => assertReleaseHistory(day, f.rows.filter((_, i) => i !== index), [f.saved])).toThrow();
  }
  expect(() => assertReleaseHistory(f.release, [...f.rows, ...f.make({ ...f.release.scope, operationId: DAY }, 71)], [])).toThrow();
});
it("V4 rejects missing, duplicated, aliased, unbound or obsolete evidence", () => {
  const { release } = twoHeldFixture(), held = release.additionalUnknown;
  for (const extra of [
    { additionalUnknown: undefined }, { additionalUnknown: release.retainedUnknown },
    { additionalUnknown: { evidence: held.evidence } },
    { additionalUnknown: { ...held, evidence: { ...held.evidence, evidenceDigest: "a".repeat(64) } } },
    { activeOperationId: held.evidence.operationId, devOperationId: held.evidence.operationId },
    { additionalFailure: { ...release.additionalFailure, operationId: held.evidence.operationId } },
    { authority: { ...release.authority, sequence: 172 } },
  ]) {
    vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify({ ...release, ...extra }));
    expect(readLimitedRelease().value).toBeNull();
  }
});
it("V4 exposes the active development fingerprint for reconciliation only with comparison disabled", () => {
  const { release, saved } = twoHeldFixture();
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(release));
  vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", "1");
  expect(() => historicalHeldReference(104, DEV)).toThrow();
  vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", "0");
  expect(historicalHeldReference(104, DEV).selection).toEqual(saved.selection);
  expect(() => historicalHeldReference(105, DEV)).toThrow();
  expect(() => historicalHeldReference(104, DAY)).toThrow();
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify({ ...release, phase: "day", activeOperationId: DAY, devSavedSnapshotDigest: saved.snapshotDigest }));
  expect(() => historicalHeldReference(104, DEV)).toThrow();
});
it("V5 reconciles each of three independent reservations without authorizing another pending row", () => {
  const f = twoHeldFixture(), operationId = "a0000000-0000-4000-8000-000000000007";
  const selection = { ...f.release.scope, operationId };
  const reference = { operationId, selection, selectionSHA256: digest(selection) };
  const rows = [...f.rows, ...f.make(selection, 61)];
  const thirdUnknown = { evidence: heldReservationEvidence(rows, reference), isolationEvidenceSHA256: "1".repeat(64) };
  const release = { ...f.release, schema: "CASE104_LIMITED_RELEASE_V5" as const,
    thirdUnknown, authority: { ...f.release.authority, sequence: 176 as const } };
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(release));
  expect(readLimitedRelease().value).toEqual(release);
  expect(historicalHeldReference(104, operationId)).toEqual(reference);
  expect(() => historicalHeldReference(104, DEV)).toThrow();
  const original = JSON.stringify(rows);
  assertReleaseHistory(release, rows, []);
  const day = { ...release, phase: "day" as const, activeOperationId: DAY, devSavedSnapshotDigest: f.saved.snapshotDigest };
  assertReleaseHistory(day, rows, [f.saved]);
  expect(() => assertReleaseHistory(day, rows, [])).toThrow();
  for (const row of rows) expect(() => assertReleaseHistory(release, rows.filter(r => r !== row), [])).toThrow();
  expect(() => assertReleaseHistory(release, [...rows, ...f.make({ ...selection, operationId: DAY }, 71)], [])).toThrow();
  expect(JSON.stringify(rows)).toBe(original);
  for (const changes of [{ thirdUnknown: undefined }, { thirdUnknown: release.additionalUnknown },
    { thirdUnknown: { ...thirdUnknown, evidence: { ...thirdUnknown.evidence, evidenceDigest: "3".repeat(64) } } },
    { activeOperationId: operationId, devOperationId: operationId }, { authority: f.release.authority }]) {
    vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify({ ...release, ...changes }));
    expect(readLimitedRelease().value).toBeNull();
  }
});
it("the previous development operation is eligible for historical fingerprinting even after admission expires", () => {
  const f = continuedFixture();
  const expired = { ...f.release, validFromUTC: "2025-01-01T00:00:00Z", validUntilUTC: "2025-01-01T01:00:00Z" };
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(expired));
  expect(readLimitedRelease().value).toBeNull();
  expect(historicalHeldReference(104, DEV).selection).toEqual(f.saved.selection);
  expect(() => historicalHeldReference(104, f.release.additionalFailure.operationId)).toThrow();
  expect(() => historicalHeldReference(105, DEV)).toThrow();
  expect(() => historicalHeldReference(104, DAY)).toThrow();
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify({ ...expired, phase: "day", activeOperationId: DAY, devSavedSnapshotDigest: f.saved.snapshotDigest }));
  expect(() => historicalHeldReference(104, DEV)).toThrow();
});
it("V3 admits development and day only with both exact terminal failures and the held operation", () => {
  const f = continuedFixture(), rows = [...f.rows, ...f.additionalRows];
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(f.release));
  expect(readLimitedRelease().value).toEqual(f.release);
  expect(historicalHeldReference(104, HELD)).toEqual(f.reference);
  const original = JSON.stringify(rows);
  assertReleaseHistory(f.release, rows, []);
  const day = { ...f.release, phase: "day" as const, activeOperationId: DAY, devSavedSnapshotDigest: f.saved.snapshotDigest };
  assertReleaseHistory(day, rows, [f.saved]);
  expect(JSON.stringify(rows)).toBe(original);
  expect(() => assertReleaseHistory(day, rows, [])).toThrow();
  for (const index of [0, 2, 4, 5]) {
    expect(() => assertReleaseHistory(f.release, rows.filter((_, i) => i !== index), [])).toThrow();
  }
  expect(() => assertReleaseHistory(f.release, [...rows, f.additionalRows[0]], [])).toThrow();
  expect(() => assertReleaseHistory(f.release, [...rows, ...f.make({ ...f.release.scope, operationId: DAY }, 51)], [])).toThrow();
  for (const field of ["auditDigest", "selectionSHA256"] as const) {
    const changed = { ...f.release, additionalFailure: { ...f.release.additionalFailure, [field]: "0".repeat(64) } };
    expect(() => assertReleaseHistory(changed, rows, [])).toThrow();
  }
});
it("V3 rejects an unrelated failure, a reused operation identity and the earlier authority", () => {
  const { release } = continuedFixture();
  for (const extra of [
    { additionalFailure: undefined }, { authority: { ...release.authority, sequence: 170 } },
    { additionalFailure: { ...release.additionalFailure, stage: "review" } },
    ...[OLD, HELD, DEV].map(operationId => ({ additionalFailure: { ...release.additionalFailure, operationId } })),
    { phase: "day", activeOperationId: release.additionalFailure.operationId, devSavedSnapshotDigest: "f".repeat(64) },
  ]) {
    vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify({ ...release, ...extra }));
    expect(readLimitedRelease().value).toBeNull();
  }
});
it("new authority admits only exact preserved known failure and two unknown rows without mutation",()=>{const f=fixture(),before=JSON.stringify(f.rows);assertReleaseHistory(f.release,f.rows,[]);expect(JSON.stringify(f.rows)).toBe(before);expect(f.evidence.rows).toHaveLength(2);expect(JSON.stringify(f.evidence)).not.toContain("matchedElementsJson");});
it("changed raw, row IDs, missing/duplicate/extra unknown rows, terminal reclassification and changed scope reject",()=>{for(const mutate of [(f:ReturnType<typeof fixture>)=>f.rows.pop(),(f:ReturnType<typeof fixture>)=>f.rows.push({...f.heldRows[0],resultId:99}),(f:ReturnType<typeof fixture>)=>f.rows[2].resultId=99,(f:ReturnType<typeof fixture>)=>f.rows[2].matchedElementsJson+=" ",(f:ReturnType<typeof fixture>)=>{const x=JSON.parse(f.rows[2].matchedElementsJson!);x.priorArtComparison.failure={stage:"generation",kind:"protocol_invalid"};f.rows[2].matchedElementsJson=JSON.stringify(x);},(f:ReturnType<typeof fixture>)=>{const x=JSON.parse(f.rows[2].matchedElementsJson!);x.priorArtComparison.selection.inputDigest="f".repeat(64);f.rows[2].matchedElementsJson=JSON.stringify(x);},(f:ReturnType<typeof fixture>)=>{const x=JSON.parse(f.rows[2].matchedElementsJson!);x.priorArtComparison.operationId=DAY;f.rows[2].matchedElementsJson=JSON.stringify(x);}]){const f=fixture();mutate(f);expect(()=>assertReleaseHistory(f.release,f.rows,[])).toThrow();}});
it("fingerprint remains read-only after config expiry but admission and wrong case/operation stay closed",()=>{const f=fixture();const legacy={...f.release,schema:"CASE104_LIMITED_RELEASE_V1",authority:{...f.release.authority,sequence:168},activeOperationId:HELD,devOperationId:HELD,validFromUTC:"2025-01-01T00:00:00Z",validUntilUTC:"2025-01-01T01:00:00Z"};delete (legacy as Record<string,unknown>).retainedUnknown;vi.stubEnv(LIMITED_RELEASE_ENV,JSON.stringify(legacy));expect(readLimitedRelease()).toEqual({configured:true,value:null});expect(historicalHeldReference(104,HELD)).toEqual(f.reference);expect(()=>historicalHeldReference(105,HELD)).toThrow();expect(()=>historicalHeldReference(104,DEV)).toThrow();});
it("V2 cannot omit isolation evidence, use old authority or exempt a different held operation",()=>{const f=fixture();for(const x of [{...f.release,retainedUnknown:{evidence:f.evidence}},{...f.release,authority:{...f.release.authority,sequence:168}},{...f.release,retainedUnknown:{evidence:{...f.evidence,operationId:DEV},isolationEvidenceSHA256:"e".repeat(64)}}]){vi.stubEnv(LIMITED_RELEASE_ENV,JSON.stringify(x));expect(readLimitedRelease().value).toBeNull();}vi.stubEnv(LIMITED_RELEASE_ENV,JSON.stringify(f.release));expect(readLimitedRelease().value).toEqual(f.release);});
it("day requires the new dev saved snapshot while retaining both old reservations",()=>{const f=fixture(),day={...f.release,phase:"day" as const,activeOperationId:DAY,devSavedSnapshotDigest:f.saved.snapshotDigest};expect(()=>assertReleaseHistory(day,f.rows,[])).toThrow();assertReleaseHistory(day,f.rows,[f.saved]);expect(()=>assertReleaseHistory({...day,devSavedSnapshotDigest:"a".repeat(64)},f.rows,[f.saved])).toThrow();});

it("a three-answer prefix audit is retained identically on both unknown rows and never becomes a terminal failure",()=>{
  const f=fixture();const tasks=[0,1].flatMap(sourceIndex=>[1,2,3].map(part=>({id:(sourceIndex?"c":"b").repeat(64)+":1:part"+part+"of3",sourceIndex,sourceDigest:(sourceIndex?"c":"b").repeat(64),claimNo:1})));
  const audit=sourceAudit(HELD,f.reference.selection.inputDigest,tasks,tasks.slice(0,3).map((task,i)=>({taskId:task.id,value:{fictionalPrefixPart:i+1}})));
  for(const row of f.heldRows){const outer=JSON.parse(row.matchedElementsJson!);outer.priorArtComparisonSourceAudit=audit;row.matchedElementsJson=JSON.stringify(outer);}
  const rows=[...f.rows.slice(0,2),...f.heldRows],evidence=heldReservationEvidence(rows,f.reference),release={...f.release,retainedUnknown:{evidence,isolationEvidenceSHA256:"e".repeat(64)}};
  const before=JSON.stringify(rows);assertReleaseHistory(release,rows,[]);expect(JSON.stringify(rows)).toBe(before);expect(evidence.rows.map(row=>row.auditDigest)).toEqual([audit.auditDigest,audit.auditDigest]);expect(JSON.stringify(evidence)).not.toContain("fictionalPrefixPart");
  const changed=structuredClone(rows),outer=JSON.parse(changed[2].matchedElementsJson!);delete outer.priorArtComparisonSourceAudit;changed[2].matchedElementsJson=JSON.stringify(outer);expect(()=>assertReleaseHistory(release,changed,[])).toThrow();
});
