import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { readTrialPolicy, trialPolicyBytes, type TrialPolicy } from "../src/lib/trial/policy";
import { operatorPolicyBinding, operatorTicketDigest, type OperatorTicket } from "../src/lib/trial/operator-access";
import { bindTrialSessionBaseline, executeTrialSession, MAX_BOOTSTRAP_BASELINE_BYTES, MAX_SESSION_REQUESTS, prepareTrialSession, runTrialSessionStdin, saveTrialRuntimePolicy, saveTrialBootstrapProof, trialProofCanonical, SessionPermit, type RuntimePolicyIO, type SessionClock } from "./trial-session";

// Fixed fictional test material. This test never generates a key pair or opens a credential file.
const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "01".repeat(32), "hex"), format: "der", type: "pkcs8" });
const otherKey = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "02".repeat(32), "hex"), format: "der", type: "pkcs8" });
const id = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const start = Date.parse("2026-10-10T10:00:00Z"), t0 = start + 60_000;
const iso = (n: number) => new Date(n).toISOString();
let wall = t0 + 1000, mono = 0;
const clock: SessionClock = { utc: () => wall, monotonic: () => mono };
function fixture() {
  const p: TrialPolicy = {
    schema: 1, approval: "LIGHTWEIGHT_GROUP_TRIAL_V3", phase: "initial", startsAt: iso(start), endsAt: iso(start + 1_800_000),
    retentionReviewAt: "2027-01-29T00:00:00Z", codeSha: "a".repeat(40),
    auth: { tenantId: id, ownerId: id, clientId: second, origin: "https://fixture.example" },
    database: { host: "fixture.postgres.database.azure.com", port: 5432, database: "trial_fixture", webUser: "trial_web", workerUser: "trial_worker", migratorUser: "trial_migrator", ownerRole: "trial_owner" },
    storage: { account: "fixturestorage", originals: "fixture-originals", artifacts: "fixture-artifacts", budget: "fixture-budget" },
    identity: { webClientId: id, workerClientId: second }, ai: { resourceName: "fixture-ai", normalDeployment: "normal", miniDeployment: "mini", apiVersion: "v1" },
    cost: { checkedAt: iso(start), validUntil: iso(start + 3_600_000), normal: { inputYenPerMillion: 100, outputYenPerMillion: 200 },
      mini: { inputYenPerMillion: 10, outputYenPerMillion: 20 }, initialOtherYen: 100, retainedOtherYen: 100, monthOtherYen: 100,
      sharedRemainingYen: 0, jobYenPerHour: 100, databaseBaselineBytes: 1024 },
    jobResourceId: `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.App/jobs/fixture`,
    environmentResourceId: `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.App/managedEnvironments/fixture`,
    samples: [{ caseId: 1, from: "2026-01-01", through: "2026-02-01" }],
  };
  const window = { lifecycleId: id, bindingDigest: "a".repeat(64), guardianNonce: "fixture-nonce",
    ruleId: `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/fixture`,
    journalUrl: "https://fixturestorage.blob.core.windows.net/fixture-guardian/state.json", jobStartedAt: iso(start), useUntil: iso(start + 600_000) };
  const access: OperatorTicket = { schema: 1, id, policyDigest: operatorPolicyBinding(p), startsAt: iso(start), endsAt: iso(start + 3_600_000),
    packages: [], samples: [], artifacts: [], databaseWindow: window };
  p.localOperator = { ticketDigest: operatorTicketDigest(access), recoveryDirectoryDigest: "c".repeat(64) };
  return {
    azureCliPython: resolve("fixture-cli", process.platform === "win32" ? "python.exe" : "python"),
    environment: { DEPLOYMENT_KIND: "trial" as const, TRIAL_POLICY_JSON: JSON.stringify(p), TRIAL_POLICY_SIGNATURE: sign(null, trialPolicyBytes(p), key).toString("base64"),
      TRIAL_POLICY_PUBLIC_KEY: createPublicKey(key).export({ type: "spki", format: "pem" }).toString() },
    access, signingPrivateKey: key.export({ type: "pkcs8", format: "pem" }).toString(),
    databaseWindow: { ...window, bindingDigest: "b".repeat(64), jobStartedAt: iso(t0), useUntil: iso(t0 + 600_000) },
    bootstrap: { mode: "apply" as const, manifest: { schema: 1 as const, adminCatalog: "postgres" as const, adminUser: "fixture_admin", cases: [{ id: 1, title: "FICTIONAL TRIAL SAMPLE 1" }] },
      credentials: { adminUrl: "postgresql://fixture_admin:fictional-admin-password@fixture.postgres.database.azure.com/postgres",
        migratorPassword: "fictional-migrator-password", webPassword: "fictional-web-password", workerPassword: "fictional-worker-password" } },
    operatorDatabaseUrl: "postgresql://trial_migrator:fictional-migrator-password@fixture.postgres.database.azure.com/trial_fixture", recoveryDirectory: "C:\\fixture-private",
    requests: [{ command: "initialize-ledger" }, { command: "status", caseId: 1 }] as unknown[],
  };
}
function grant(window: ReturnType<typeof fixture>["databaseWindow"], until = wall + 9000) {
  return { type: "permit", lifecycleId: window.lifecycleId, bindingDigest: window.bindingDigest, guardianNonce: window.guardianNonce, useUntil: window.useUntil, permitUntil: iso(until) };
}
const bootstrapSuccess = () => ({ status: "bootstrapped", databaseBaselineBytes: 8192, cases: 1, automaticResend: false, receipts: [{name: "operator-" + "d".repeat(64) + ".jsonl", sha256: "f".repeat(64)}] });
const artifactSuccess = async () => ({ sha256: "e".repeat(64) });
const operatorSuccess = (value: unknown) => (value as { request: { command: string } }).request.command === "status" ?
  { runs: [], deliveries: [], ledgerRevision: 0 } : { status: "initialized" };
function controlled(input = fixture()) {
  const stop = vi.fn(), prepared = prepareTrialSession(input, clock), permit = new SessionPermit(prepared.databaseWindow, stop, clock);
  permit.grant(grant(input.databaseWindow)); return { prepared, permit, stop };
}
function sampleFixture() {
  const input = fixture(), sha256 = "d".repeat(64), p = readTrialPolicy(input.environment);
  input.access.samples = [{ caseId: 1, sha256, key: `cases/1/prior-art/${start}-${id}-sample.xml` }];
  p.localOperator!.ticketDigest = operatorTicketDigest(input.access);
  input.environment.TRIAL_POLICY_JSON = JSON.stringify(p);
  input.environment.TRIAL_POLICY_SIGNATURE = sign(null, trialPolicyBytes(p), key).toString("base64");
  input.requests = [{ command: "sample-save", caseId: 1, sourcePath: "C:\\fixture.xml", packageType: "JPA", entryPath: "fictional.xml",
    kind: "A1", publicationNumber: "FICTIONAL", publicationDate: "20260101", sha256 },
    { command: "setting-save", setting: { caseId: 1, contractSignedOn: "2025-12-01", monitoringStartsOn: "2026-01-01",
      contractEndsOn: "2026-02-01", enabled: true, selectedClaimNos: [1],
      base: { $sessionResult: { requestIndex: 0, field: "base" } }, source: { $sessionResult: { requestIndex: 0, field: "source" } } } }];
  const result = { status: "saved", base: { publicationNumber: "FICTIONAL", version: "A1",
    claims: [{ claimNo: 1, text: "fictional independent claim", dependsOn: [] }] },
    source: { documentId: 41, packageType: "JPA", entryPath: "fictional.xml", sha256, publicationDate: "20260101", applicationNumber: "FICTIONAL-1" } };
  return { input, result };
}
beforeEach(() => { vi.useFakeTimers(); wall = t0 + 1000; mono = 0; vi.setSystemTime(wall); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("signed stdin trial session", () => {
  it("keeps policy dates/DB fields and uses the existing Ed25519 key for only the ticket window and derived digest", () => {
    const input = fixture(), oldPolicy = readTrialPolicy(input.environment), prepared = prepareTrialSession(input, clock);
    const p = readTrialPolicy(prepared.common.environment), ticket = prepared.common.access;
    expect(p).toEqual({ ...oldPolicy,
      localOperator: { ...oldPolicy.localOperator, ticketDigest: operatorTicketDigest(ticket) } });
    expect(ticket).toEqual({ ...input.access, policyDigest: operatorPolicyBinding(p), databaseWindow: input.databaseWindow });
    expect(prepared.common.environment.TRIAL_POLICY_PUBLIC_KEY).toBe(input.environment.TRIAL_POLICY_PUBLIC_KEY);
    expect(prepared.bootstrap.azureCliPython).toBe(input.azureCliPython);
    expect(prepared.common.azureCliPython).toBe(input.azureCliPython);
    expect(prepared).not.toHaveProperty("signingPrivateKey");
  });
  it("refuses unsigned policy, changed ticket, missing signed DB binding, and a different existing key", () => {
    const a = fixture(); a.environment.TRIAL_POLICY_SIGNATURE = "A".repeat(86) + "==";
    const b = fixture(); b.access.packages = ["d".repeat(64)];
    const c = fixture(); delete c.access.databaseWindow;
    const d = fixture(); d.signingPrivateKey = otherKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const input of [a, b, c, d]) expect(() => prepareTrialSession(input, clock)).toThrow();
  });
  it.each(["lifecycleId", "guardianNonce", "ruleId", "journalUrl"] as const)("refuses static signed window substitution: %s", field => {
    const input = fixture(); input.databaseWindow[field] = field === "lifecycleId" ? second : input.databaseWindow[field] + "changed";
    expect(() => prepareTrialSession(input, clock)).toThrow();
  });
  it("cannot enlarge the approved policy or ten-minute DB window", () => {
    const a = fixture(); a.databaseWindow.useUntil = iso(t0 + 600_001);
    const b = fixture(); b.databaseWindow.jobStartedAt = iso(start + 1_500_000); b.databaseWindow.useUntil = iso(start + 2_100_000);
    expect(() => prepareTrialSession(a, clock)).toThrow(); expect(() => prepareTrialSession(b, clock)).toThrow();
  });
  it("caps invocations at one bootstrap plus sixteen operators before any adapter dispatch", async () => {
    const input = fixture(); input.requests = Array.from({ length: MAX_SESSION_REQUESTS }, () => ({ command: "status", caseId: 1 }));
    const { prepared, permit } = controlled(input), bootstrap = vi.fn(async () => bootstrapSuccess()), operator = vi.fn(async (value: unknown) => operatorSuccess(value));
    try { expect(await executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap, operator })).toMatchObject({ status: "completed", completedRequests: 16 });
      expect(bootstrap).toHaveBeenCalledOnce(); expect(operator).toHaveBeenCalledTimes(16); }
    finally { permit.dispose(); }
    input.requests.push({ command: "status", caseId: 1 }); expect(() => prepareTrialSession(input, clock)).toThrow();
  });
  it("awaits bootstrap and each command sequentially; a failed command is never retried", async () => {
    const { prepared, permit } = controlled(), calls: string[] = []; let release: () => void = () => undefined;
    const bootstrap = vi.fn(async () => { calls.push("bootstrap"); await new Promise<void>(r => { release = r; }); return bootstrapSuccess(); });
    const operator = vi.fn(async (v: unknown) => { calls.push((v as { request: { command: string } }).request.command); throw Error("private adapter failure"); });
    const work = executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap, operator });
    try { await vi.advanceTimersByTimeAsync(0); expect(calls).toEqual(["bootstrap"]); release();
      await expect(work).rejects.toThrow(); expect(calls).toEqual(["bootstrap", "initialize-ledger"]); expect(operator).toHaveBeenCalledOnce(); }
    finally { permit.dispose(); }
  });
  it("starts no command after bootstrap completes beyond the current permit", async () => {
    const { prepared, permit, stop } = controlled(), operator = vi.fn(async () => ({}));
    try { await expect(executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap: async () => { mono += 9000; return {}; }, operator })).rejects.toThrow();
      expect(operator).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); }
    finally { permit.dispose(); }
  });
  it("refuses reference fields outside exact sample-save to same-case setting base/source", () => {
    const input = fixture(); input.requests = [{ command: "sample-save", caseId: 1 },
      { command: "status", caseId: { $sessionResult: { requestIndex: 0, field: "source" } } }];
    expect(() => prepareTrialSession(input, clock)).toThrow();
  });
  it("passes the same-case saved sample's exact base/source into the following setting sequentially", async () => {
    const { input, result } = sampleFixture(), { prepared, permit } = controlled(input), seen: unknown[] = [];
    const bootstrap = vi.fn(async () => bootstrapSuccess());
    const operator = vi.fn(async (v: unknown) => { seen.push(v); return seen.length === 1 ? result : { status: "saved" }; });
    try {
      expect(await executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap, operator })).toMatchObject({ status: "completed", completedRequests: 2 });
      expect(bootstrap).toHaveBeenCalledOnce(); expect(operator).toHaveBeenCalledTimes(2);
      const setting = (seen[1] as { request: { setting: { base: unknown; source: unknown } } }).request.setting;
      expect(setting.base).toEqual(result.base); expect(setting.source).toEqual(result.source);
      expect((input.requests[1] as { setting: { source: unknown } }).setting.source).toEqual({ $sessionResult: { requestIndex: 0, field: "source" } });
    } finally { permit.dispose(); }
  });
  it.each(["unknown", "malformed-source"])("does not dispatch setting after %s sample result", async mode => {
    const { input, result } = sampleFixture(), { prepared, permit } = controlled(input);
    const operator = vi.fn(async () => mode === "unknown" ? { status: "reconciliation_required" } : { ...result, source: { documentId: 0 } });
    try { await expect(executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap: async () => bootstrapSuccess(), operator })).rejects.toThrow();
      expect(operator).toHaveBeenCalledOnce(); } finally { permit.dispose(); }
  });
  it.each(["different-case", "forward-reference", "cross-field", "extra-setting-key"])("preflights invalid result references: %s", mode => {
    const { input } = sampleFixture(), setting = (input.requests[1] as { setting: Record<string, unknown> }).setting;
    if (mode === "different-case") setting.caseId = 2;
    else if (mode === "forward-reference") setting.source = { $sessionResult: { requestIndex: 1, field: "source" } };
    else if (mode === "cross-field") setting.source = { $sessionResult: { requestIndex: 0, field: "base" } };
    else setting.unapproved = true;
    expect(() => prepareTrialSession(input, clock)).toThrow();
  });
  it("does not equate a resolved unknown bootstrap or operator result with success", async () => {
    const first = controlled(), operator = vi.fn(async (value: unknown) => operatorSuccess(value));
    try { await expect(executeTrialSession(first.prepared, first.permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap: async () => ({ status: "outcome_unknown" }), operator })).rejects.toThrow();
      expect(operator).not.toHaveBeenCalled(); } finally { first.permit.dispose(); }
    const second = controlled(), unknown = vi.fn(async () => ({ status: "outcome_unknown" }));
    try { await expect(executeTrialSession(second.prepared, second.permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap: async () => bootstrapSuccess(), operator: unknown })).rejects.toThrow();
      expect(unknown).toHaveBeenCalledOnce(); } finally { second.permit.dispose(); }
  });
  it("does not count a pending Job reconciliation as completed work", async () => {
    const input = fixture(); input.requests = [{ command: "job-reconcile", caseId: 1, runId: id }];
    const { prepared, permit } = controlled(input), operator = vi.fn(async () => ({ operationId: id, status: "accepted", executionStatus: "Running" }));
    try { await expect(executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap: async () => bootstrapSuccess(), operator })).rejects.toThrow();
      expect(operator).toHaveBeenCalledOnce(); } finally { permit.dispose(); }
  });
});

describe("process permit and stdin lifetime", () => {
  it.each(["bindingDigest", "guardianNonce", "lifecycleId", "useUntil"])("stops for changed permit binding %s", field => {
    const input = fixture(), stop = vi.fn(), permit = new SessionPermit(input.databaseWindow, stop, clock);
    try { const p = { ...grant(input.databaseWindow), [field]: "changed" }; expect(() => permit.grant(p)).toThrow();
      expect(stop).toHaveBeenCalledOnce(); expect(permit.signal.aborted).toBe(true); }
    finally { permit.dispose(); }
  });
  it("rejects more than ten seconds, the absolute cutoff, and renewal after expiry", async () => {
    for (const until of [wall + 10001, Date.parse(fixture().databaseWindow.useUntil) + 1]) {
      const input = fixture(), permit = new SessionPermit(input.databaseWindow, vi.fn(), clock);
      try { expect(() => permit.grant(grant(input.databaseWindow, until))).toThrow(); } finally { permit.dispose(); }
    }
    const input = fixture(), { permit, stop } = controlled(input);
    mono += 9000; await vi.advanceTimersByTimeAsync(25);
    expect(stop).toHaveBeenCalledOnce(); expect(() => permit.grant(grant(input.databaseWindow, wall + 10000))).toThrow(); permit.dispose();
  });
  it("does not extend with wall rollback or a frozen wall clock", async () => {
    const first = controlled(); wall -= 1; expect(() => first.permit.check()).toThrow(); first.permit.dispose();
    wall = t0 + 1000; const secondPermit = controlled(); mono += 9000; await vi.advanceTimersByTimeAsync(25);
    expect(secondPermit.stop).toHaveBeenCalledOnce(); secondPermit.permit.dispose();
  });
  it("processes private initial and permit lines without requiring EOF and returns only fixed summary", async () => {
    const input = fixture(), stream = new PassThrough(), stop = vi.fn(), bootstrap = vi.fn(async () => ({ ...bootstrapSuccess(), secret: "must-not-output" }));
    const work = runTrialSessionStdin(stream, { clock, onStop: stop, adapters: { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap, operator: async value => ({ ...operatorSuccess(value), secret: "must-not-output" }) } });
    stream.write(JSON.stringify(input) + "\n" + JSON.stringify(grant(input.databaseWindow)) + "\n");
    const result = await work; expect(result).toMatchObject({ status: "completed", completedRequests: 2 }); expect(stop).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret"); expect(bootstrap).toHaveBeenCalledOnce(); stream.destroy();
  });
  it("bridges the full stdin payload through bootstrap/sample/setting with the actual signed window", async () => {
    const { input, result } = sampleFixture(), stream = new PassThrough(), stop = vi.fn(), calls: unknown[] = [];
    const work = runTrialSessionStdin(stream, { clock, onStop: stop, adapters: {
      bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess,
      bootstrap: async value => { calls.push(value); return bootstrapSuccess(); },
      operator: async value => { calls.push(value); return calls.length === 2 ? result : { status: "saved" }; },
    } });
    stream.write(JSON.stringify(input) + "\n" + JSON.stringify(grant(input.databaseWindow)) + "\n");
    expect(await work).toMatchObject({ status: "completed", completedRequests: 2 });
    expect(calls).toHaveLength(3); expect(stop).not.toHaveBeenCalled();
    for (const call of calls) {
      const c = call as { environment: Record<string, string>; access: OperatorTicket };
      expect(readTrialPolicy(c.environment).endsAt).toBe(readTrialPolicy(input.environment).endsAt);
      expect(c.access.databaseWindow).toEqual(input.databaseWindow);
    }
    expect((calls[2] as { request: { setting: { source: unknown } } }).request.setting.source).toEqual(result.source);
    stream.destroy();
  });
  it("parent EOF stops an in-flight bootstrap and dispatches no operator", async () => {
    const input = fixture(), stream = new PassThrough(), stop = vi.fn(), entered = vi.fn(), operator = vi.fn(async () => ({}));
    const work = runTrialSessionStdin(stream, { clock, onStop: stop, adapters: { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap: async () => { entered(); return new Promise(() => undefined); }, operator } });
    const assertion = expect(work).rejects.toThrow("trial_session_reconciliation_required");
    stream.write(JSON.stringify(input) + "\n" + JSON.stringify(grant(input.databaseWindow)) + "\n");
    await vi.advanceTimersByTimeAsync(0); expect(entered).toHaveBeenCalledOnce(); stream.end();
    await assertion; expect(stop).toHaveBeenCalledOnce(); expect(operator).not.toHaveBeenCalled();
  });
  it("missing first permit, malformed frames and input exceeding 2MiB all fail closed", async () => {
    for (const mode of ["no-permit", "bad-frame", "too-large"] as const) {
      const input = fixture(), stream = new PassThrough(), stop = vi.fn(), bootstrap = vi.fn(async () => ({}));
      const work = runTrialSessionStdin(stream, { clock, onStop: stop, adapters: { bootstrapProof: artifactSuccess, runtimePolicy: artifactSuccess, bootstrap, operator: async () => ({}) } });
      const assertion = expect(work).rejects.toThrow();
      stream.write(mode === "too-large" ? Buffer.alloc(2 * 1024 ** 2 + 1) : JSON.stringify(input) + "\n");
      if (mode === "bad-frame") stream.write("not-json\n");
      if (mode === "no-permit") { await vi.advanceTimersByTimeAsync(0); mono += 5000; await vi.advanceTimersByTimeAsync(5000); }
      await assertion; expect(stop).toHaveBeenCalledOnce(); expect(bootstrap).not.toHaveBeenCalled(); stream.destroy();
    }
  });
});

describe("owner-private runtime policy artifact", () => {
  function preparedArtifact() {
    const input = fixture(); input.recoveryDirectory = resolve("fixture-private-runtime");
    const p = readTrialPolicy(input.environment);
    p.localOperator!.recoveryDirectoryDigest = createHash("sha256").update(resolve(input.recoveryDirectory)).digest("hex");
    input.environment.TRIAL_POLICY_JSON = JSON.stringify(p);
    input.environment.TRIAL_POLICY_SIGNATURE = sign(null, trialPolicyBytes(p), key).toString("base64");
    return { input, prepared: bindTrialSessionBaseline(prepareTrialSession(input, clock), 8192) };
  }
  it("writes only signed public environment with exclusive creation and fsync, without altering policy dates", async () => {
    const { input, prepared } = preparedArtifact(), order: string[] = []; let saved = "";
    const handle = { writeFile: vi.fn(async (value: string) => { order.push("write"); saved = value; }),
      sync: vi.fn(async () => { order.push("sync"); }), close: vi.fn(async () => { order.push("close"); }) };
    const io: RuntimePolicyIO = { inspect: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })),
      create: vi.fn(async () => { order.push("create"); return handle; }) };
    const result = await saveTrialRuntimePolicy(prepared, "final", io);
    expect(io.create).toHaveBeenCalledWith(join(input.recoveryDirectory, "trial-runtime-policy.json"), "wx", 0o600);
    expect(order).toEqual(["create", "write", "sync", "close"]);
    expect(JSON.parse(saved)).toEqual(prepared.common.environment);
    expect(result.sha256).toBe(createHash("sha256").update(saved).digest("hex"));
    expect(readTrialPolicy(JSON.parse(saved)).startsAt).toBe(readTrialPolicy(input.environment).startsAt);
    expect(readTrialPolicy(JSON.parse(saved)).endsAt).toBe(readTrialPolicy(input.environment).endsAt);
    expect(saved).not.toContain("PRIVATE KEY");
    for (const secret of Object.values(input.bootstrap.credentials)) expect(saved).not.toContain(secret);
    expect(saved).not.toContain(input.operatorDatabaseUrl);
  });
  it("does not overwrite an existing or uncertain artifact and rejects the wrong directory", async () => {
    const { prepared } = preparedArtifact(), create = vi.fn(async () => { throw Error("EEXIST"); });
    const io: RuntimePolicyIO = { inspect: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), create };
    await expect(saveTrialRuntimePolicy(prepared, "final", io)).rejects.toThrow(); expect(create).toHaveBeenCalledOnce();
    const changed = prepared; changed.common = { ...changed.common, recoveryDirectory: resolve("different-directory") };
    await expect(saveTrialRuntimePolicy(changed, "final", io)).rejects.toThrow(); expect(create).toHaveBeenCalledOnce();
  });
  it("closes a partial artifact after fsync failure and never retries its creation", async () => {
    const { prepared } = preparedArtifact(), close = vi.fn(async () => undefined), create = vi.fn(async () => ({
      writeFile: async () => undefined, sync: async () => { throw Error("fsync failed"); }, close }));
    await expect(saveTrialRuntimePolicy(prepared, "final", { inspect: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), create })).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("awaits durable artifact completion before any bootstrap or operator dispatch", async () => {
    const { prepared, permit } = controlled(); let finish: () => void = () => undefined;
    const runtimePolicy = vi.fn(async (_prepared: unknown, phase: "pending" | "final") => {
      if (phase === "pending") await new Promise<void>(resolve => { finish = resolve; });
      return artifactSuccess();
    });
    const bootstrap = vi.fn(async () => bootstrapSuccess()), operator = vi.fn(async (value: unknown) => operatorSuccess(value));
    const work = executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy, bootstrap, operator });
    try { await vi.advanceTimersByTimeAsync(0); expect(runtimePolicy).toHaveBeenCalledOnce(); expect(bootstrap).not.toHaveBeenCalled(); expect(operator).not.toHaveBeenCalled();
      finish(); await expect(work).resolves.toMatchObject({ status: "completed", completedRequests: 2 }); }
    finally { permit.dispose(); }
  });
  it("dispatches no DB adapter after the artifact save is unconfirmed", async () => {
    const { prepared, permit } = controlled(), bootstrap = vi.fn(async () => bootstrapSuccess()), operator = vi.fn(async (value: unknown) => operatorSuccess(value));
    try { await expect(executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: async () => { throw Error("unknown save"); }, bootstrap, operator })).rejects.toThrow();
      expect(bootstrap).not.toHaveBeenCalled(); expect(operator).not.toHaveBeenCalled(); }
    finally { permit.dispose(); }
  });
  it("uses a separate pending filename and cannot save an unmeasured final policy", async () => {
    const { input } = preparedArtifact(), prepared = prepareTrialSession(input, clock), files: string[] = [];
    const io: RuntimePolicyIO = { inspect: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      create: async path => { files.push(path); return { writeFile: async () => undefined, sync: async () => undefined, close: async () => undefined }; } };
    await saveTrialRuntimePolicy(prepared, "pending", io);
    expect(files).toEqual([join(input.recoveryDirectory, "trial-runtime-policy.pending.json")]);
    await expect(saveTrialRuntimePolicy(prepared, "final", io)).rejects.toThrow(); expect(files).toHaveLength(1);
    await saveTrialRuntimePolicy(bindTrialSessionBaseline(prepared, 8192), "final", io);
    expect(files[1]).toBe(join(input.recoveryDirectory, "trial-runtime-policy.json"));
  });
  it("writes a fixed canonical bootstrap proof privately and keeps all secrets out", async () => {
    const { input, prepared } = preparedArtifact(); let saved = "";
    const sync = vi.fn(async () => undefined), close = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ writeFile: async (value: string) => { saved = value; }, sync, close }));
    const result = await saveTrialBootstrapProof(prepared, bootstrapSuccess(), {
      inspect: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), create });
    expect(create).toHaveBeenCalledWith(join(input.recoveryDirectory, "trial-bootstrap-proof.json"), "wx", 0o600);
    expect(sync).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(saved)).toMatchObject({ schema: 1, receiptScope: "verified_steps_this_invocation",
      databaseWindow: prepared.databaseWindow, bootstrap: { databaseBaselineBytes: 8192, automaticResend: false } });
    expect(saved).toBe(trialProofCanonical(JSON.parse(saved)) + "\n");
    expect(result.sha256).toBe(createHash("sha256").update(saved).digest("hex"));
    expect(saved).not.toContain("PRIVATE KEY");
    for (const secret of Object.values(input.bootstrap.credentials)) expect(saved).not.toContain(secret);
  });
  it("cannot emit completion or dispatch operators after an uncertain proof save", async () => {
    const { prepared, permit } = controlled(), operator = vi.fn(async () => ({status:"initialized"}));
    try { await expect(executeTrialSession(prepared, permit, { runtimePolicy: artifactSuccess,
      bootstrap: async () => bootstrapSuccess(), bootstrapProof: async () => { throw Error("fsync unknown"); }, operator })).rejects.toThrow();
      expect(operator).not.toHaveBeenCalled(); }
    finally { permit.dispose(); }
  });
  it("returns only bound proof hashes/counts and never receipt filenames", async () => {
    const { prepared, permit } = controlled();
    try { const result = await executeTrialSession(prepared, permit, { runtimePolicy: artifactSuccess, bootstrapProof: artifactSuccess,
      bootstrap: async () => bootstrapSuccess(), operator: async value => operatorSuccess(value) });
      expect(result.bootstrap).toMatchObject({ schema:1, status:"bootstrapped", databaseBaselineBytes:8192, cases:1,
        automaticResend:false, finalRuntimePolicySha256:"e".repeat(64), proofSha256:"e".repeat(64), receiptCount:1 });
      expect(result.bootstrap.databaseWindowDigest).toBe(createHash("sha256").update(trialProofCanonical(prepared.databaseWindow)).digest("hex"));
      expect(JSON.stringify(result)).not.toContain("operator-"); expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    } finally { permit.dispose(); }
  });
});

describe("measured baseline binding before ledger initialization", () => {
  it("requires an existing signed cost profile before any bootstrap", () => {
    const input = fixture(), p = readTrialPolicy(input.environment); delete p.cost;
    input.access.policyDigest = operatorPolicyBinding(p); p.localOperator!.ticketDigest = operatorTicketDigest(input.access);
    input.environment.TRIAL_POLICY_JSON = JSON.stringify(p); input.environment.TRIAL_POLICY_SIGNATURE = sign(null, trialPolicyBytes(p), key).toString("base64");
    expect(() => prepareTrialSession(input, clock)).toThrow();
  });
  it("changes only measured DB bytes and derived ticket digests, keeping prices, targets and all dates", () => {
    const initial = prepareTrialSession(fixture(), clock), before = readTrialPolicy(initial.common.environment), final = bindTrialSessionBaseline(initial, 32 * 1024 ** 2);
    const after = readTrialPolicy(final.common.environment);
    expect(after).toEqual({ ...before, cost: { ...before.cost!, databaseBaselineBytes: 32 * 1024 ** 2 },
      localOperator: { ...before.localOperator!, ticketDigest: operatorTicketDigest(final.common.access) } });
    expect(final.common.access).toEqual({ ...initial.common.access, policyDigest: operatorPolicyBinding(after) });
    expect(final.common.environment.TRIAL_POLICY_PUBLIC_KEY).toBe(initial.common.environment.TRIAL_POLICY_PUBLIC_KEY);
    expect(() => bindTrialSessionBaseline(initial, 8192)).toThrow();
  });
  it.each([-1, 0.5, NaN, Infinity, MAX_BOOTSTRAP_BASELINE_BYTES + 1])("rejects invalid/unapproved measured capacity %s before any operator", async bytes => {
    const { prepared, permit } = controlled(), operator = vi.fn(async (value: unknown) => operatorSuccess(value)), artifact = vi.fn(artifactSuccess);
    try { await expect(executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifact,
      bootstrap: async () => ({ ...bootstrapSuccess(), databaseBaselineBytes: bytes }), operator })).rejects.toThrow();
      expect(operator).not.toHaveBeenCalled(); expect(artifact).toHaveBeenCalledOnce(); }
    finally { permit.dispose(); }
  });
  it("orders pending, bootstrap, measured final and every operator with one shared final signed policy", async () => {
    const { prepared, permit } = controlled(), order: string[] = [], environments: string[] = [];
    try { await expect(executeTrialSession(prepared, permit, {
      bootstrapProof: async () => { order.push("proof"); return artifactSuccess(); }, runtimePolicy: async (p, phase) => { order.push(phase); const policy = readTrialPolicy(p.common.environment);
        expect(policy.cost!.databaseBaselineBytes).toBe(phase === "pending" ? 1024 : 8192); if (phase === "final") environments.push(JSON.stringify(p.common.environment)); return artifactSuccess(); },
      bootstrap: async () => { order.push("bootstrap"); return bootstrapSuccess(); },
      operator: async value => { order.push("operator"); const v = value as { environment: Record<string, string>; access: OperatorTicket };
        environments.push(JSON.stringify(v.environment)); const policy = readTrialPolicy(v.environment);
        expect(policy.cost!.databaseBaselineBytes).toBe(8192); expect(operatorPolicyBinding(policy)).toBe(v.access.policyDigest);
        expect(policy.localOperator!.ticketDigest).toBe(operatorTicketDigest(v.access)); return operatorSuccess(value); },
    })).resolves.toMatchObject({ status: "completed", completedRequests: 2 });
      expect(order).toEqual(["pending", "bootstrap", "final", "proof", "operator", "operator"]); expect(new Set(environments).size).toBe(1);
    } finally { permit.dispose(); }
  });
  it("retains unknown overall and sends no operator when measured final save fails", async () => {
    const { prepared, permit } = controlled(), bootstrap = vi.fn(async () => bootstrapSuccess()), operator = vi.fn(async (value: unknown) => operatorSuccess(value));
    const artifact = vi.fn(async (_p: unknown, phase: "pending" | "final") => { if (phase === "final") throw Error("fsync unknown"); });
    try { await expect(executeTrialSession(prepared, permit, { bootstrapProof: artifactSuccess, runtimePolicy: artifact, bootstrap, operator })).rejects.toThrow();
      expect(bootstrap).toHaveBeenCalledOnce(); expect(operator).not.toHaveBeenCalled(); expect(artifact).toHaveBeenCalledTimes(2); }
    finally { permit.dispose(); }
  });
});
