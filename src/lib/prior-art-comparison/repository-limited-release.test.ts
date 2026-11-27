import { beforeEach, afterEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], tables: {} as Record<string, unknown>, raw: {} as Record<string, unknown[]>, locked: false,
  select: vi.fn(), transaction: vi.fn(), executeAI: vi.fn(), acquired: true }));
vi.mock("@/db", () => ({ db: { select: seam.select, transaction: seam.transaction } }));
vi.mock("@/db/schema", () => import("../../db/schema"));
vi.mock("./execute", () => ({ executeComparison: seam.executeAI, PROPOSITION_GENERATION_SYSTEM: "fictional system" }));
vi.mock("@/repositories/managed-case-graph", () => ({ lockManagedCase: vi.fn() }));
vi.mock("./proposition-plan", () => ({ assertPropositionPlan: vi.fn() }));
vi.mock("./source-separation", () => ({ separatedGenerationPlan: () => [] }));
vi.mock("./source-claim-extraction", () => ({ sourceClaimExtractionPlan: () => ({ tasks: [] }) }));
import * as tables from "../../db/schema";
import { fictionalSaved } from "./fixtures.test-support";
import { savedDigest, type Selection } from "./comparison";
import { digest } from "./source";
import { sourceAudit } from "./source-audit";
import { reserveComparison, completeReservedComparison, listComparisons, comparisonAdmission, getComparisonSourceAudit, getHeldComparisonEvidence } from "./repository";
import { LIMITED_RELEASE_ENV, type LimitedRelease } from "./limited-release";
import { heldReservationEvidence, type HeldRow } from "./held-reservation";
const OLD = "b0000000-0000-4000-8000-000000000001", DEV = "b0000000-0000-4000-8000-000000000002", DAY = "b0000000-0000-4000-8000-000000000003";
let release: LimitedRelease, selected: Selection, saved: ReturnType<typeof fictionalSaved>, oldBytes: string[];
beforeEach(() => {
  vi.resetAllMocks(); seam.rows = []; seam.locked = false; seam.acquired = true;
  saved = fictionalSaved(); saved.inputs.caseId = 104; saved.operationId = DEV; saved.selection.operationId = DEV;
  const text = (source: typeof saved.inputs.draft) => source.source.claims.map(claim => `【請求項${claim.claimNo}】${claim.text}`).join("\n");
  const draft = { draftId: saved.inputs.draft.id, parsedText: text(saved.inputs.draft) };
  const documents = saved.inputs.documents.map(source => ({ docId: source.id, claimsText: text(source), publicationNo: source.source.publicationNumber, title: "fictional" }));
  const inputDigest = digest({ caseId: 104, title: "fictional", draft: { id: draft.draftId, text: draft.parsedText }, documents: documents.map(doc => ({ id: doc.docId, publication: doc.publicationNo, title: doc.title, text: doc.claimsText })) });
  saved.inputs.inputDigest = inputDigest; saved.selection.inputDigest = inputDigest; saved.snapshotDigest = savedDigest(saved); selected = saved.selection;
  const { operationId: ignored, ...scope } = selected; void ignored;
  const oldSelection = { ...selected, operationId: OLD }, audit = sourceAudit(OLD, inputDigest, [{ id: "e".repeat(64) + ":1", sourceIndex: 0, sourceDigest: "e".repeat(64), claimNo: 1 }], []);
  const failure = { stage: "generation" as const, kind: "protocol_invalid" as const }, marker = { version: 1, status: "reserved", operationId: OLD, selection: oldSelection, failure };
  seam.rows = selected.documents.map((doc, index) => ({ resultId: index + 1, caseId: 104, priorDocId: doc.docId, draftClaimId: String(selected.draftClaimNos[0]),
    matchedElementsJson: JSON.stringify({ priorArtComparison: marker, priorArtComparisonSourceAudit: audit }) }));
  oldBytes = seam.rows.map(row => String(row.matchedElementsJson));
  release = { schema: "CASE104_LIMITED_RELEASE_V1", caseId: 104, phase: "dev", activeOperationId: DEV, devOperationId: DEV,
    validFromUTC: new Date(Date.now() - 1000).toISOString(), validUntilUTC: new Date(Date.now() + 60000).toISOString(),
    authority: { sequence: 168, envelopeSHA256: "a".repeat(64), ownerDecisionSHA256: "b".repeat(64) }, scope,
    oldFailure: { operationId: OLD, selectionSHA256: digest(oldSelection), auditDigest: audit.auditDigest, ...failure },
    budget: { maximumSends: 8, maximumJPY: 500, inputYenPer100k: 7, outputYenPer100k: 19 } };
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(release));
  const query = () => { let table: unknown; const q = { from(value: unknown) { table = value; return q; }, where() { return q; }, orderBy() { return q; }, for() { return q; },
    then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(table === tables.cases ? [{ caseId: 104, title: "fictional" }] : table === tables.draftPatents ? [draft] : table === tables.priorArtDocuments ? documents : seam.rows).then(resolve); } }; return q; };
  seam.select.mockImplementation(query);
  const insert = () => ({ values(values: Record<string, unknown>[]) {
    const added = values.map((value, index) => ({ ...value, resultId: value.resultId ?? Math.max(0, ...seam.rows.map(row => Number(row.resultId))) + index + 1 }));
    const commit = () => { seam.rows.push(...added); };
    return { returning: async () => { commit(); return added.map(row => ({ id: row.resultId })); }, then(resolve: (value?: unknown) => unknown) { commit(); return Promise.resolve().then(() => resolve()); } };
  } });
  const remove = () => ({ where: () => ({ returning: async () => { const own = seam.rows.filter(row => JSON.parse(String(row.matchedElementsJson)).priorArtComparison.operationId === DEV);
    seam.rows = seam.rows.filter(row => !own.includes(row)); return own; } }) });
  seam.transaction.mockImplementation(async callback => { let statements = 0, owned = false;
    try { return await callback({ select: query, insert, delete: remove, execute: async () => { statements++;
      if (statements !== 2) return { rows: [] }; if (seam.locked || !seam.acquired) return { rows: [{ acquired: false }] }; seam.locked = owned = true; return { rows: [{ acquired: true }] }; } }); }
    finally { if (owned) seam.locked = false; }
  });
  seam.executeAI.mockResolvedValue(saved);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("new designated reservation preserves exact old rows and binds the validated server allocation", async () => {
  expect(await comparisonAdmission(104)).toMatchObject({ restricted: true, operationId: DEV, canStart: true });
  const reservation = await reserveComparison(104, selected); expect(reservation.ids).toHaveLength(2);
  expect(reservation.allocation).toMatchObject({ phase: "dev", maximumJPY: 500, maximumSends: 8, inputYenPer100k: 7, outputYenPer100k: 19 });
  expect(seam.rows.slice(0, 2).map(row => row.matchedElementsJson)).toEqual(oldBytes);
  await expect(reserveComparison(104, selected)).rejects.toMatchObject({ code: "save_unconfirmed" }); expect(seam.executeAI).not.toHaveBeenCalled();
});
it("parallel reservation requests cannot create or dispatch two operations", async () => {
  const results = await Promise.allSettled([reserveComparison(104, selected), reserveComparison(104, selected)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(seam.rows).toHaveLength(4); expect(seam.executeAI).not.toHaveBeenCalled();
});
it("wrong operation/case/scope, unknown reservation and expired configuration reject before inserting", async () => {
  for (const [caseId, selection] of [[105, selected], [104, { ...selected, operationId: DAY }], [104, { ...selected, inputDigest: "c".repeat(64) }]] as const)
    await expect(reserveComparison(caseId, selection)).rejects.toBeDefined();
  seam.rows.push({ ...seam.rows[0], resultId: 99, matchedElementsJson: JSON.stringify({ priorArtComparison: { version: 1, status: "reserved", operationId: DAY, selection: { ...selected, operationId: DAY } } }) });
  await expect(reserveComparison(104, selected)).rejects.toBeDefined(); seam.rows.pop();
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify({ ...release, validUntilUTC: new Date(Date.now() - 1).toISOString() }));
  await expect(reserveComparison(104, selected)).rejects.toBeDefined(); expect(seam.rows).toHaveLength(2); expect(seam.executeAI).not.toHaveBeenCalled();
});
it("old failure and new completed result coexist; repeated GET/audit reads cannot send AI or rearm dev", async () => {
  const reservation = await reserveComparison(104, selected); await completeReservedComparison(104, selected, reservation);
  expect(seam.executeAI).toHaveBeenCalledOnce(); expect(seam.executeAI.mock.calls[0][3]).toEqual(reservation.allocation);
  for (let count = 0; count < 2; count++) { const listed = await listComparisons(104); expect(listed.results.map(value => value.operationId)).toEqual([DEV]); expect(listed.failedOperations.map(value => value.operationId)).toEqual([OLD]);
    expect((await getComparisonSourceAudit(104, OLD)).operationId).toBe(OLD); }
  expect(await comparisonAdmission(104)).toMatchObject({ canStart: false, operationId: DEV });
  await expect(reserveComparison(104, selected)).rejects.toBeDefined(); expect(seam.executeAI).toHaveBeenCalledOnce(); expect(seam.rows.slice(0, 2).map(row => row.matchedElementsJson)).toEqual(oldBytes);
});
it("deadline/config changes after commit leave the reservation and prevent dispatch", async () => {
  const reservation = await reserveComparison(104, selected); vi.stubEnv(LIMITED_RELEASE_ENV, "{}");
  await expect(completeReservedComparison(104, selected, reservation)).rejects.toBeDefined(); expect(seam.executeAI).not.toHaveBeenCalled(); expect(seam.rows).toHaveLength(4);
});

function successorFixture() {
  const heldId="b0000000-0000-4000-8000-000000000004",heldSelection={...selected,operationId:heldId};
  seam.rows.push(...selected.documents.map((doc,i)=>({resultId:31+i,caseId:104,priorDocId:doc.docId,draftClaimId:String(selected.draftClaimNos[0]),matchedElementsJson:JSON.stringify({priorArtComparison:{version:1,status:"reserved",operationId:heldId,selection:heldSelection}})})));
  const evidence=heldReservationEvidence(seam.rows as HeldRow[],{operationId:heldId,selection:heldSelection,selectionSHA256:digest(heldSelection)});
  const successor:LimitedRelease={...release,schema:"CASE104_LIMITED_RELEASE_V2",authority:{...release.authority,sequence:170},retainedUnknown:{evidence,isolationEvidenceSHA256:"e".repeat(64)}};
  vi.stubEnv(LIMITED_RELEASE_ENV,JSON.stringify(successor));return {heldId,successor,evidence};
}
it("successor reservation preserves both predecessor groups and cannot rearm either",async()=>{
  const {heldId}=successorFixture(),before=JSON.stringify(seam.rows);
  expect(await comparisonAdmission(104)).toMatchObject({canStart:true,operationId:DEV});
  await expect(reserveComparison(104,{...selected,operationId:heldId})).rejects.toBeDefined();
  const reservation=await reserveComparison(104,selected);expect(reservation.ids).toHaveLength(2);expect(JSON.stringify(seam.rows.slice(0,4))).toBe(before);
  await expect(reserveComparison(104,selected)).rejects.toBeDefined();expect(seam.executeAI).not.toHaveBeenCalled();
});
it("expired successor OWNER fingerprints use two reads and never reserve, transact or send AI",async()=>{
  const {heldId,successor,evidence}=successorFixture();vi.stubEnv(LIMITED_RELEASE_ENV,JSON.stringify({...successor,validFromUTC:"2025-01-01T00:00:00Z",validUntilUTC:"2025-01-01T01:00:00Z"}));
  const before=JSON.stringify(seam.rows);expect(await getHeldComparisonEvidence(104,heldId)).toEqual({evidence,historicalReadOnly:true,aiSends:0,rowWrites:0});
  expect(JSON.stringify(seam.rows)).toBe(before);expect(seam.transaction).not.toHaveBeenCalled();expect(seam.executeAI).not.toHaveBeenCalled();
  await expect(getHeldComparisonEvidence(105,heldId)).rejects.toBeDefined();await expect(getHeldComparisonEvidence(104,DAY)).rejects.toBeDefined();
});
it("fingerprint read rejects changes between its two snapshots",async()=>{
  const {heldId}=successorFixture(),original=seam.select.getMockImplementation()!;let reads=0;
  seam.select.mockImplementation(()=>{if(++reads===2)seam.rows[2].matchedElementsJson=String(seam.rows[2].matchedElementsJson)+" ";return original();});
  await expect(getHeldComparisonEvidence(104,heldId)).rejects.toMatchObject({code:"save_unconfirmed"});expect(seam.transaction).not.toHaveBeenCalled();expect(seam.executeAI).not.toHaveBeenCalled();
});

it("admits one new slot while the audited source failure stays readable and cannot be retried", async () => {
  const history = (id: number, stage?: "source_reading" | "generation") => {
    const operationId = `b0000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
    const selection = { ...selected, operationId }, selectionSHA256 = digest(selection);
    const task = { id: "c".repeat(64) + ":1", sourceIndex: 0, sourceDigest: "c".repeat(64), claimNo: 1 };
    const failure = { stage, kind: "protocol_invalid" as const };
    const audit = sourceAudit(operationId, selection.inputDigest, [task], [],
      stage === "source_reading" ? { taskId: task.id, text: "fictional incomplete reading" } : undefined);
    for (const [i, doc] of selection.documents.entries()) {
      const marker = { version: 1, status: "reserved", operationId, selection, ...(stage ? { failure } : {}) };
      seam.rows.push({ resultId: id * 10 + i, caseId: 104, priorDocId: doc.docId, draftClaimId: String(selection.draftClaimNos[0]),
        matchedElementsJson: JSON.stringify({ priorArtComparison: marker, ...(stage ? { priorArtComparisonSourceAudit: audit } : {}) }) });
    }
    return { operationId, selection, selectionSHA256, auditDigest: audit.auditDigest };
  };
  const held = (id: number) => {
    const reference = history(id);
    return { evidence: heldReservationEvidence(seam.rows as HeldRow[], reference), isolationEvidenceSHA256: "e".repeat(64) };
  };
  const additionalFailure = history(5, "generation");
  const v5 = { ...release, schema: "CASE104_LIMITED_RELEASE_V5", authority: { ...release.authority, sequence: 176 },
    additionalFailure: { operationId: additionalFailure.operationId, selectionSHA256: additionalFailure.selectionSHA256,
      auditDigest: additionalFailure.auditDigest, stage: "generation", kind: "protocol_invalid" },
    retainedUnknown: held(6), additionalUnknown: held(7), thirdUnknown: held(8) };
  const source = history(9, "source_reading");
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(v5));
  expect((await comparisonAdmission(104)).canStart).toBe(false);
  const v6 = { ...v5, schema: "CASE104_LIMITED_RELEASE_V6", authority: { ...v5.authority, sequence: 178 },
    sourceFailure: { operationId: source.operationId, selectionSHA256: source.selectionSHA256,
      auditDigest: source.auditDigest, stage: "source_reading", kind: "protocol_invalid" } };
  vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(v6));
  const previousRows = structuredClone(seam.rows);
  expect(await comparisonAdmission(104)).toMatchObject({ operationId: DEV, canStart: true });
  expect((await getComparisonSourceAudit(104, source.operationId)).auditDigest).toBe(source.auditDigest);
  await expect(reserveComparison(104, source.selection)).rejects.toBeDefined();
  expect((await reserveComparison(104, selected)).ids).toHaveLength(2);
  expect((await comparisonAdmission(104)).canStart).toBe(false);
  await expect(reserveComparison(104, selected)).rejects.toBeDefined();
  expect(seam.rows.slice(0, previousRows.length)).toEqual(previousRows);
  expect(seam.executeAI).not.toHaveBeenCalled();
});
