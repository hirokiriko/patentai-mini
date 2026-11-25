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
import { reserveComparison, completeReservedComparison, listComparisons, comparisonAdmission, getComparisonSourceAudit } from "./repository";
import { LIMITED_RELEASE_ENV, type LimitedRelease } from "./limited-release";
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
