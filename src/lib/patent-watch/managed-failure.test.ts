import { describe, expect, it, vi } from "vitest";
import { ManagedWatchRepository } from "../../repositories/managed-watch";
import { ManagedClaimsError, managedDigest, planManagedComparisons, validateManagedComparisons } from "./managed-claims";
import { isManagedFailureCode, managedFailureCode } from "./managed-failure";
import { executeManagedRun } from "./managed-service";
import { managedBaseDigest, ManagedWatchError, type ManagedRun, type ManagedSetting } from "./managed-types";

const secret = "FICTIONAL-PRIVATE-SENTINEL";
function fixture() {
  const base = { publicationNumber: "JP-FICTIONAL-BASE", version: "A1",
    claims: [{ claimNo: 1, text: "架空の検出装置。", dependsOn: [] }] };
  const source = { ...base, publicationNumber: "JP-FICTIONAL-CANDIDATE" };
  const value = { caseId: 1, enabled: true, contractSignedOn: "2026-07-24", monitoringStartsOn: "2026-07-26", contractEndsOn: null,
    source: { documentId: 1, packageType: "JPA" as const, entryPath: "fictional.xml", sha256: "a".repeat(64),
      publicationDate: "20260726", applicationNumber: "FICTIONAL-BASE" }, base, selectedClaimNos: [1] };
  const setting: ManagedSetting = { ...value, settingId: 1, baseDigest: managedBaseDigest(value) };
  const snapshot: ManagedRun["snapshot"] = { schema: 1, setting, period: { from: "2026-07-26", to: "2026-08-25" },
    sourceKeys: ["b".repeat(64)], candidates: [{ candidateId: 2, sourceKey: "b".repeat(64), publicationDate: "2026-08-01",
      inventionTitle: "架空の装置", applicationNumber: "FICTIONAL-CANDIDATE", abstract: null, source,
      claimsStatus: "complete", lexicalScore: 0.5 }], scannedDocuments: 1, incompleteDocuments: 0, sourceBytes: 100 };
  const run: ManagedRun = { runId: "fictional-run", caseId: 1, settingId: 1, status: "running", snapshot,
    snapshotDigest: managedDigest(snapshot), plan: null, consumedNormal: 0, executionId: "fictional-execution",
    acceptedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const plan = planManagedComparisons(base, [1], [{ candidateId: 2, source }]);
  const result = { results: [{ baseClaimNo: 1, candidateClaimNo: 1, lexicalScore: 0.5, elementScore: 0.5, semanticScore: 0.5,
    structuralScore: 0.5, riskLabel: "Medium" as const, explanation: "架空の比較。人手確認が必要です。",
    baseEvidence: { claimNo: 1, start: 0, end: 8, quote: base.claims[0].text },
    candidateEvidence: { claimNo: 1, start: 0, end: 8, quote: source.claims[0].text } }] };
  const saved: Record<string, unknown>[] = [];
  // Exercise the actual fail persistence boundary without accessing any database.
  const database = { update: vi.fn(() => ({ set: (row: Record<string, unknown>) => {
    saved.push(row); return { where: vi.fn(async () => undefined) };
  } })) };
  const persistence = new ManagedWatchRepository(database as unknown as ConstructorParameters<typeof ManagedWatchRepository>[0]);
  const repository = { claim: vi.fn(async () => run), journal: vi.fn(() => ({ reserve: vi.fn(), reconcile: vi.fn() })),
    saveScreening: vi.fn(async () => plan), saveDetail: vi.fn(async (_run: ManagedRun, index: number, output: unknown) => {
      validateManagedComparisons(plan.chunks[index], output);
    }), finalize: vi.fn(async () => ({ compared: 1 })), hasUnknownDispatch: vi.fn(async () => false),
    fail: vi.fn(persistence.fail.bind(persistence)) };
  const analysis = { screening: vi.fn(async () => ({ decisions: [{ candidateId: 2, selected: true, reason: "technical_overlap" as const }] })),
    detail: vi.fn(async () => result) };
  const proof: NonNullable<Parameters<typeof executeManagedRun>[5]> = { operationId: "fictional-operation", snapshotDigest: run.snapshotDigest,
    aiBudget: { maximumYen: 1, inputYenPerMillion: 1, outputYenPerMillion: 1 } };
  return { run, result, plan, repository, analysis, saved, persistence, proof,
    execute: () => executeManagedRun(repository as unknown as ManagedWatchRepository, 1, run.runId, "fictional-execution", analysis, proof) };
}

describe("managed failure classifications", () => {
  it("persists finite internal codes without exception text, causes or arbitrary codes", () => {
    expect(managedFailureCode("detail_save", new ManagedClaimsError("coverage_invalid", "evidence_quote")))
      .toBe("incomplete:detail_save:evidence_quote");
    expect(managedFailureCode("detail_request", new ManagedWatchError("limit"))).toBe("incomplete:detail_request:limit");
    const forged = new ManagedClaimsError("coverage_invalid");
    Object.assign(forged, { code: secret, reason: secret });
    for (const error of [new Error(secret, { cause: secret }), { code: secret, message: secret }, forged]) {
      expect(managedFailureCode("detail_save", error)).toBe("incomplete:detail_save:unclassified");
    }
    for (const code of [secret, "incomplete:other:limit", `incomplete:detail_save:${secret}`, "incomplete:detail_save:limit:extra"])
      expect(isManagedFailureCode(code)).toBe(false);
  });
  it("keeps evidence validation failures distinct from detail request and storage failures", async () => {
    const f = fixture(); f.result.results[0].candidateEvidence.quote = secret;
    await expect(f.execute()).rejects.toThrow("incomplete");
    expect(f.saved[0]).toMatchObject({ status: "failed", errorCode: "incomplete:detail_save:evidence_quote" });
    expect(JSON.stringify(f.saved)).not.toContain(secret);
    expect(f.analysis.screening).toHaveBeenCalledTimes(1); expect(f.analysis.detail).toHaveBeenCalledTimes(1);
    expect(f.repository.finalize).not.toHaveBeenCalled();
  });
  it("never invokes exception accessors or lets a hostile proxy prevent failure recording", async () => {
    const getter = vi.fn(() => { throw new Error(secret); });
    const accessor = new ManagedClaimsError("coverage_invalid");
    Object.defineProperties(accessor, { code: { get: getter }, reason: { get: getter } });
    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error(secret); } });
    const descriptorProxy = new Proxy(new ManagedClaimsError("coverage_invalid"), {
      getOwnPropertyDescriptor: () => { throw new Error(secret); },
    });
    for (const error of [accessor, proxy, descriptorProxy]) {
      expect(managedFailureCode("detail_request", error)).toBe("incomplete:detail_request:unclassified");
      const f = fixture(); f.analysis.detail.mockRejectedValueOnce(error);
      await expect(f.execute()).rejects.toThrow("incomplete");
      expect(f.saved[0]).toMatchObject({ status: "failed", errorCode: "incomplete:detail_request:unclassified" });
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["request", "storage", "finalize"] as const)("records a %s failure without re-sending AI", async stage => {
    const f = fixture();
    if (stage === "request") f.analysis.detail.mockRejectedValueOnce(new Error(secret));
    if (stage === "storage") f.repository.saveDetail.mockRejectedValueOnce(new Error(secret));
    if (stage === "finalize") f.repository.finalize.mockRejectedValueOnce(new Error(secret));
    await expect(f.execute()).rejects.toThrow("incomplete");
    expect(f.saved[0]).toMatchObject({ status: "failed", errorCode:
      `incomplete:${stage === "request" ? "detail_request" : stage === "storage" ? "detail_save" : "finalize"}:unclassified` });
    expect(f.analysis.screening).toHaveBeenCalledTimes(1); expect(f.analysis.detail).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.saved)).not.toContain(secret);
  });
  it("retains unknown dispatch precedence and never clears it with a diagnostic", async () => {
    const f = fixture(); f.analysis.detail.mockRejectedValueOnce(new Error(secret)); f.repository.hasUnknownDispatch.mockResolvedValue(true);
    await expect(f.execute()).rejects.toThrow("outcome_unknown");
    expect(f.saved[0]).toMatchObject({ status: "unknown", errorCode: "outcome_unknown" });
    expect(f.repository.finalize).not.toHaveBeenCalled();
    expect(f.analysis.detail).toHaveBeenCalledTimes(1);
  });
  it("does not mark reservations resolved when reconciliation cannot be read", async () => {
    const f = fixture(); f.analysis.detail.mockRejectedValueOnce(new Error("request failed"));
    f.repository.hasUnknownDispatch.mockRejectedValueOnce(new Error("read failed"));
    await expect(f.execute()).rejects.toThrow("read failed"); expect(f.saved).toEqual([]);
    expect(f.repository.fail).not.toHaveBeenCalled(); expect(f.analysis.detail).toHaveBeenCalledTimes(1);
  });
  it("rejects untrusted diagnostics at the persistence boundary and preserves the legacy fallback", async () => {
    const f = fixture(); await f.persistence.fail(f.run, false, secret); await f.persistence.fail(f.run, false);
    expect(f.saved.map(row => row.errorCode)).toEqual(["incomplete", "incomplete"]);
  });
  it("keeps a successful comparison on the normal finalization path", async () => {
    const f = fixture(); await expect(f.execute()).resolves.toEqual({ compared: 1 });
    expect(f.saved).toEqual([]); expect(f.repository.finalize).toHaveBeenCalledTimes(1);
  });
  it("records a no-change finalization failure while keeping AI sends at zero", async () => {
    const f = fixture(); f.proof.mode = "no_change_only";
    Object.assign(f.run.snapshot, { candidates: [], sourceKeys: [], scannedDocuments: 0, incompleteDocuments: 0, sourceBytes: 0 });
    f.repository.finalize.mockRejectedValueOnce(new Error(secret));
    await expect(f.execute()).rejects.toThrow("incomplete");
    expect(f.saved[0]).toMatchObject({ status: "failed", errorCode: "incomplete:finalize:unclassified" });
    expect(f.repository.journal).not.toHaveBeenCalled();
    expect(f.analysis.screening).not.toHaveBeenCalled(); expect(f.analysis.detail).not.toHaveBeenCalled();
  });
});
