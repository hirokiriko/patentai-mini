import { beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ rows: [] as unknown[], transaction: vi.fn(), select: vi.fn(), executeAI: vi.fn(), preflight: vi.fn(), insert: vi.fn(), delete: vi.fn(), inputs: false }));
vi.mock("@/db", () => ({ db: { transaction: seam.transaction, select: seam.select } }));
vi.mock("./execute", () => ({ executeComparison: seam.executeAI, PROPOSITION_GENERATION_SYSTEM: "fictional system" }));
vi.mock("@/db/schema", () => import("../../db/schema"));
vi.mock("@/repositories/managed-case-graph", () => ({ lockManagedCase: vi.fn() }));
vi.mock("./comparison", async () => ({ ...(await vi.importActual<typeof import("./comparison")>("./comparison")), makePlan: () => [] }));
vi.mock("./proposition-plan", () => ({ assertPropositionPlan: seam.preflight }));
vi.mock("./source-separation", () => ({ separatedGenerationPlan: () => [] }));
vi.mock("./source-claim-extraction", () => ({ sourceClaimExtractionPlan: () => ({ tasks: [{id:("b".repeat(64)+":1"),sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1}] }) }));
import { sourceAudit } from "./source-audit";
import { reserveComparison, completeReservedComparison, listComparisons, getComparisonSourceAudit } from "./repository";
import { ComparisonExecutionError } from "./failure";
import { digest } from "./source";
import type { Selection } from "./comparison";
import * as tables from "../../db/schema";
const selection: Selection = { operationId: "12345678-1234-4234-8234-123456789abc", inputDigest: "a".repeat(64), draftClaimNos: [1],
  draftIdentity: { publication: "fictional", edition: "1" }, originalsConfirmed: true,
  documents: [1,2].map(docId => ({ docId, claimNos: [1], identity: { publication: `fictional ${docId}`, edition: "1" } })) };
beforeEach(() => {
  vi.resetAllMocks(); seam.inputs = false;
  seam.rows = [{ resultId: 1, caseId: 1, draftClaimId: "1", priorDocId: 1,
    matchedElementsJson: JSON.stringify({ priorArtComparison: { version: 1, status: "reserved", operationId: selection.operationId, selection } }) }];
  const query = () => { let table: unknown; const q = { from: (value: unknown): unknown => { table = value; return q; }, for: (): unknown => q, where: (): unknown => q, orderBy: (): unknown => q,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(seam.inputs ? table === tables.cases ? [{ caseId: 1, title: "fictional" }] : table === tables.draftPatents ? [{ draftId: 1, parsedText: "【請求項1】装置。" }] : table === tables.priorArtDocuments ? [1,2].map(docId => ({ docId, claimsText: "【請求項1】装置。", publicationNo: `fictional ${docId}`, title: "fictional" })) : seam.rows : seam.rows).then(resolve) }; return q; };
  seam.select.mockImplementation(query);
  seam.transaction.mockImplementation(async callback => callback({ execute: async () => ({ rows: [{ acquired: true }] }), select: query, insert: seam.insert, delete: seam.delete }));
});
it("an existing reserved operation returns pending without AI or reservation mutation", async () => {
  await expect(reserveComparison(1, selection)).resolves.toEqual({ pending: true });
  expect(seam.executeAI).not.toHaveBeenCalled();
});
it("changing a reserved operation selection cannot schedule another dispatch", async () => {
  await expect(reserveComparison(1, { ...selection, draftClaimNos: [2] })).rejects.toMatchObject({ code: "selection_invalid" });
  expect(seam.executeAI).not.toHaveBeenCalled();
});
it("another operation cannot bypass a leftover reservation", async () => {
  await expect(reserveComparison(1, { ...selection, operationId: "22345678-1234-4234-8234-123456789abc" })).rejects.toMatchObject({ code: "save_unconfirmed" });
  expect(seam.executeAI).not.toHaveBeenCalled();
});

async function freshReservation() {
  seam.inputs = true; seam.rows = [];
  seam.insert.mockImplementation(() => ({ values: (rows: Record<string, unknown>[]) => {
    seam.rows = rows.map((row, i) => ({ ...row, resultId: i+1 }));
    return { returning: async () => [{ id: 1 }, { id: 2 }] };
  } }));
  const rawDigest = digest({ caseId: 1, title: "fictional", draft: { id: 1, text: "【請求項1】装置。" }, documents: [1,2].map(id => ({ id, publication: `fictional ${id}`, title: "fictional", text: "【請求項1】装置。" })) });
  const selected = { ...selection, inputDigest: rawDigest };
  const reservation = await reserveComparison(1, selected);
  seam.inputs = false;
  seam.delete.mockImplementation(() => ({ where: () => ({ returning: async () => seam.rows }) }));
  return { selected, reservation };
}
it("preflight rejects capacity before inserting a reservation", async () => {
  seam.preflight.mockImplementation(() => { throw Error("too large"); });
  await expect(freshReservation()).rejects.toThrow("too large");
  expect(seam.insert).not.toHaveBeenCalled(); expect(seam.executeAI).not.toHaveBeenCalled();
});
it("a fresh capability can dispatch only once even after failure", async () => {
  const { selected, reservation } = await freshReservation();
  seam.executeAI.mockRejectedValue(new ComparisonExecutionError("source_reading", "timeout"));
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow();
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toMatchObject({ code: "save_unconfirmed" });
  expect(seam.executeAI).toHaveBeenCalledOnce(); expect(seam.delete).not.toHaveBeenCalled();
});
it.each(["protocol_invalid", "review_rejected", "output_incomplete"] as const)("records only a known %s on the exact reserved rows", async kind => {
  const { selected, reservation } = await freshReservation();
  seam.executeAI.mockRejectedValue(new ComparisonExecutionError("source_reading", kind));
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow();
  expect(seam.delete).toHaveBeenCalledOnce();
  const marker = JSON.parse((seam.rows[0] as { matchedElementsJson: string }).matchedElementsJson).priorArtComparison;
  expect(marker.status).toBe("reserved"); expect(marker.failure).toEqual({ stage: "source_reading", kind });
  await expect(reserveComparison(1, selected)).resolves.toEqual({ pending: true });
  expect(seam.executeAI).toHaveBeenCalledOnce();
});
it.each(["timeout", "transport_unknown", "usage_invalid"] as const)("keeps %s unconfirmed without a known-failure write", async kind => {
  const { selected, reservation } = await freshReservation();
  seam.executeAI.mockRejectedValue(new ComparisonExecutionError("source_reading", kind));
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow();
  expect(seam.delete).not.toHaveBeenCalled();
});
it("a failure write with an unknown ACK cannot dispatch again", async () => {
  const { selected, reservation } = await freshReservation();
  seam.executeAI.mockRejectedValue(new ComparisonExecutionError("review", "review_rejected"));
  seam.delete.mockImplementation(() => { throw Error("unknown write"); });
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow();
  expect(JSON.parse((seam.rows[0] as { matchedElementsJson: string }).matchedElementsJson).priorArtComparison.failure).toBeUndefined();
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow(); expect(seam.executeAI).toHaveBeenCalledOnce();
});

it("a copied or mutated reservation is not a dispatch capability", async () => {
  const { selected, reservation } = await freshReservation();
  await expect(completeReservedComparison(1, selected, { ...reservation })).rejects.toThrow();
  await expect(completeReservedComparison(2, selected, reservation)).rejects.toThrow();
  expect(seam.executeAI).not.toHaveBeenCalled();
});
it("reads a consistent failure marker while keeping the no-retry reservation", async () => {
  const { selected, reservation } = await freshReservation();
  seam.executeAI.mockRejectedValue(new ComparisonExecutionError("review", "review_rejected"));
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow();
  const result = await listComparisons(1);
  expect(result.reservedCount).toBe(1); expect(result.results).toEqual([]);
  expect(result.failedOperations).toEqual([{ operationId: selected.operationId, failure: { stage: "review", kind: "review_rejected" } }]);
});
it("a partial or extended failure marker cannot expose a known failure", async () => {
  const { selected, reservation } = await freshReservation();
  seam.executeAI.mockRejectedValue(new ComparisonExecutionError("review", "review_rejected"));
  await expect(completeReservedComparison(1, selected, reservation)).rejects.toThrow();
  const first = seam.rows[0] as { matchedElementsJson: string };
  const value = JSON.parse(first.matchedElementsJson); value.priorArtComparison.failure.extra = "not public";
  first.matchedElementsJson = JSON.stringify(value);
  expect((await listComparisons(1)).failedOperations).toEqual([]);
});

it("persists source evidence before a later quality failure and retrieves it without AI", async () => {
  const { selected, reservation } = await freshReservation();
  const audit = sourceAudit(selected.operationId, selected.inputDigest,[{id:("b".repeat(64)+":1"),sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1}], [{taskId:("b".repeat(64)+":1"),value:{v:999,original:"原文"}}]);
  seam.executeAI.mockImplementation(async (_inputs,_selection,sink) => { await sink(audit); throw new ComparisonExecutionError("review","review_rejected"); });
  await expect(completeReservedComparison(1,selected,reservation)).rejects.toThrow();
  expect(seam.delete).toHaveBeenCalledTimes(2);
  expect(await getComparisonSourceAudit(1,selected.operationId)).toEqual(audit);
  expect((await listComparisons(1)).failedOperations).toHaveLength(1);
  await getComparisonSourceAudit(1,selected.operationId);
  expect(seam.executeAI).toHaveBeenCalledOnce();
  seam.rows.pop();
  await expect(getComparisonSourceAudit(1,selected.operationId)).rejects.toThrow();
});
it("an audit transaction unknown ACK stops before any continuation and never permits replay",async()=>{
 const { selected,reservation }=await freshReservation();
 const audit=sourceAudit(selected.operationId,selected.inputDigest,[{id:("b".repeat(64)+":1"),sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1}],[]);
 const continued=vi.fn();
 seam.delete.mockImplementation(()=>{throw Error("unknown ACK");});
 seam.executeAI.mockImplementation(async(_inputs,_selection,sink)=>{await sink(audit);continued();});
 await expect(completeReservedComparison(1,selected,reservation)).rejects.toThrow();
 expect(continued).not.toHaveBeenCalled();
 await expect(completeReservedComparison(1,selected,reservation)).rejects.toThrow();
 expect(seam.executeAI).toHaveBeenCalledOnce();
});

it("keeps the exact audit through completed-result replacement and later GETs",async()=>{
 const {selected,reservation}=await freshReservation();
 const audit=sourceAudit(selected.operationId,selected.inputDigest,[{id:("b".repeat(64)+":1"),sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1}],[{taskId:("b".repeat(64)+":1"),value:{v:999}}]);
 const saved={version:1,status:"complete",operationId:selected.operationId,selection:selected,inputs:reservation.inputs,generatedAt:"fictional"};
 seam.executeAI.mockImplementation(async(_inputs,_selection,sink)=>{await sink(audit);seam.inputs=true;return saved;});
 await expect(completeReservedComparison(1,selected,reservation)).resolves.toEqual(saved);
 seam.inputs=false;
 expect(JSON.parse((seam.rows[0] as {matchedElementsJson:string}).matchedElementsJson).priorArtComparisonSourceAudit).toEqual(audit);
 expect(seam.executeAI).toHaveBeenCalledOnce();expect(seam.delete).toHaveBeenCalledTimes(2);
 const first=seam.rows[0] as {matchedElementsJson:string};
 const outer=JSON.parse(first.matchedElementsJson);outer.priorArtComparisonSourceAudit.answers[0].value={tampered:true};first.matchedElementsJson=JSON.stringify(outer);
 await expect(getComparisonSourceAudit(1,selected.operationId)).rejects.toThrow();
});

it("revalidates complete snapshot and source-task roster before private readback",async()=>{
 const {fictionalSaved,fictionalAnswer}=await import("./fixtures.test-support");
 const saved=fictionalSaved();
 const real=await vi.importActual<typeof import("./comparison")>("./comparison");
 saved.pairs=real.makePlan(saved.inputs,saved.selection).flatMap(chunk=>real.validateAnswer(chunk,fictionalAnswer(chunk)));
 saved.snapshotDigest=real.savedDigest(saved);
 const audit=sourceAudit(saved.operationId,saved.inputs.inputDigest,[{id:"b".repeat(64)+":1",sourceIndex:0,sourceDigest:"b".repeat(64),claimNo:1}],[{taskId:"b".repeat(64)+":1",value:{v:999}}]);
 seam.rows=saved.inputs.documents.map((doc,i)=>({resultId:i+1,caseId:saved.inputs.caseId,draftClaimId:"1",priorDocId:doc.id,matchedElementsJson:JSON.stringify({priorArtComparison:saved,priorArtComparisonSourceAudit:audit})}));
 expect(await getComparisonSourceAudit(saved.inputs.caseId,saved.operationId)).toEqual(audit);
 const altered=sourceAudit(saved.operationId,saved.inputs.inputDigest,[{id:"c".repeat(64)+":1",sourceIndex:0,sourceDigest:"c".repeat(64),claimNo:1}],[]);
 seam.rows=seam.rows.map(row=>({...row as object,matchedElementsJson:JSON.stringify({priorArtComparison:saved,priorArtComparisonSourceAudit:altered})}));
 await expect(getComparisonSourceAudit(saved.inputs.caseId,saved.operationId)).rejects.toThrow();
 expect(seam.executeAI).not.toHaveBeenCalled();
});
