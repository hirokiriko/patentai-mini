import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createHash, createPrivateKey, createPublicKey, sign} from "node:crypto";
import {resolve} from "node:path";
import {prepareTrialCatalogPayload} from "./trial-catalog-prepare";
import {catalogBootstrapBinding, catalogStartSchema, validateCatalogCommands} from "./trial-catalog-session";
import {prepareTrialSession, trialSessionInput} from "./trial-session";
import {operatorPolicyBinding, operatorTicketDigest, type OperatorTicket} from "../src/lib/trial/operator-access";
import {readTrialPolicy, trialPolicyBytes, type TrialPolicy} from "../src/lib/trial/policy";
import {catalogDigest, CATALOG_QUERY_SET_SHA256, CATALOG_QUERY_BYTES, CATALOG_ROW_LIMIT, CATALOG_SNAPSHOT_BYTES} from "../src/lib/trial/catalog-queries";
import {loadCatalogBuiltins} from "../src/lib/trial/catalog-builtins";
import {CatalogAccess} from "../src/lib/trial/catalog-access";
import {CatalogAudit} from "../src/lib/trial/catalog-runtime";

// The fixed fictional Ed25519 bytes match the trial-session test convention.
// No key generation, credential files, DB connection or network is used.
const key = createPrivateKey({key: Buffer.from("302e020100300506032b657004220420" + "01".repeat(32), "hex"), format: "der", type: "pkcs8"});
const otherKey = createPrivateKey({key: Buffer.from("302e020100300506032b657004220420" + "02".repeat(32), "hex"), format: "der", type: "pkcs8"});
const id = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const start = Date.parse("2026-10-10T10:00:00Z"), began = start + 60_000, now = began + 1000;
const iso = (n: number) => new Date(n).toISOString();
const clock = {utc: () => now, monotonic: () => 0};
const packageSha = "e".repeat(64), sampleSha = "d".repeat(64);

function fixture() {
  const cases = [1, 2, 3, 4].map(id => ({id, title: `FICTIONAL TRIAL SAMPLE ${id}`}));
  const recoveryDirectory = resolve("fictional-owner-private");
  const p: TrialPolicy = {
    schema: 1, approval: "LIGHTWEIGHT_GROUP_TRIAL_V3", phase: "initial", startsAt: iso(start), endsAt: iso(start + 1_800_000),
    retentionReviewAt: "2027-01-29T00:00:00Z", codeSha: "a".repeat(40),
    auth: {tenantId: id, ownerId: id, clientId: second, origin: "https://fixture.example"},
    database: {host: "fixture.postgres.database.azure.com", port: 5432, database: "trial_fixture", webUser: "trial_web", workerUser: "trial_worker", migratorUser: "trial_migrator", ownerRole: "trial_owner"},
    storage: {account: "fixturestorage", originals: "fixture-originals", artifacts: "fixture-artifacts", budget: "fixture-budget"},
    identity: {webClientId: id, workerClientId: second}, ai: {resourceName: "fixture-ai", normalDeployment: "normal", miniDeployment: "mini", apiVersion: "v1"},
    cost: {checkedAt: iso(start), validUntil: iso(start + 3_600_000), normal: {inputYenPerMillion: 100, outputYenPerMillion: 200},
      mini: {inputYenPerMillion: 10, outputYenPerMillion: 20}, initialOtherYen: 100, retainedOtherYen: 100, monthOtherYen: 100,
      sharedRemainingYen: 0, jobYenPerHour: 100, databaseBaselineBytes: 1024},
    jobResourceId: `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.App/jobs/fixture`,
    environmentResourceId: `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.App/managedEnvironments/fixture`,
    samples: cases.map(c => ({caseId: c.id, from: "2026-01-01", through: "2026-02-01"})),
  };
  const window = {lifecycleId: id, bindingDigest: "a".repeat(64), guardianNonce: "fixture-nonce",
    ruleId: `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/fixture`,
    journalUrl: "https://fixturestorage.blob.core.windows.net/fixture-guardian/state.json", jobStartedAt: iso(start), useUntil: iso(start + 600_000)};
  const access: OperatorTicket = {schema: 1, id, policyDigest: operatorPolicyBinding(p), startsAt: iso(start), endsAt: iso(start + 3_600_000),
    packages: [packageSha], samples: cases.map(c => ({caseId: c.id, sha256: sampleSha, key: `cases/${c.id}/prior-art/${start}-${id}-sample.xml`})),
    artifacts: [], databaseWindow: window};
  p.localOperator = {ticketDigest: operatorTicketDigest(access), recoveryDirectoryDigest: createHash("sha256").update(recoveryDirectory).digest("hex")};
  const requests: unknown[] = [{command: "initialize-ledger"}, {command: "package-import", sourcePath: resolve("fictional.zip"), sha256: packageSha}];
  for (const c of cases) {
    const requestIndex = requests.length;
    requests.push({command: "sample-save", caseId: c.id, sourcePath: resolve(`fictional-${c.id}.xml`), packageType: "JPA", entryPath: `fictional-${c.id}.xml`,
      kind: "A1", publicationNumber: `FICTIONAL-${c.id}`, publicationDate: "20260101", sha256: sampleSha});
    requests.push({command: "setting-save", setting: {caseId: c.id, contractSignedOn: "2025-12-01", monitoringStartsOn: "2026-01-01",
      contractEndsOn: "2026-02-01", enabled: true, selectedClaimNos: [1],
      base: {$sessionResult: {requestIndex, field: "base"}}, source: {$sessionResult: {requestIndex, field: "source"}}}});
  }
  return {
    payload: {
      azureCliPython: resolve("fixture-cli", process.platform === "win32" ? "python.exe" : "python"),
      environment: {DEPLOYMENT_KIND: "trial" as const, TRIAL_POLICY_JSON: JSON.stringify(p), TRIAL_POLICY_SIGNATURE: sign(null, trialPolicyBytes(p), key).toString("base64"),
        TRIAL_POLICY_PUBLIC_KEY: createPublicKey(key).export({type: "spki", format: "pem"}).toString()},
      access, signingPrivateKey: key.export({type: "pkcs8", format: "pem"}).toString(),
      databaseWindow: {...window, bindingDigest: "b".repeat(64), jobStartedAt: iso(began), useUntil: iso(began + 600_000)},
      bootstrap: {mode: "apply" as const, manifest: {schema: 1 as const, adminCatalog: "postgres" as const, adminUser: "fixture_admin", cases},
        credentials: {adminUrl: "postgresql://fixture_admin:fictional-admin-password@fixture.postgres.database.azure.com/postgres",
          migratorPassword: "fictional-migrator-password", webPassword: "fictional-web-password", workerPassword: "fictional-worker-password"}},
      operatorDatabaseUrl: "postgresql://trial_migrator:fictional-migrator-password@fixture.postgres.database.azure.com/trial_fixture",
      recoveryDirectory, requests,
    },
    excludedDatabases: [{name: "template0", template: true, allowConnect: false as const}],
    authoritySha256: "f".repeat(64), temporaryOwnerSet: true,
  };
}

beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(now);});
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks();});

describe("catalog payload producer and signed consumers", () => {
  it("adds only the signed catalog digest, preserves the original key, ticket, targets, cost and windows", () => {
    const input = fixture(), before = structuredClone(input), original = readTrialPolicy(input.payload.environment);
    const result = prepareTrialCatalogPayload(input), policy = readTrialPolicy(result.environment);
    expect(input).toEqual(before);
    expect(policy).toEqual({...original, localOperator: {...original.localOperator, catalogPlanDigest: catalogDigest(result.catalogPlan)}});
    expect(result.environment.TRIAL_POLICY_PUBLIC_KEY).toBe(input.payload.environment.TRIAL_POLICY_PUBLIC_KEY);
    expect(result.signingPrivateKey).toBe(input.payload.signingPrivateKey);
    expect(result.access).toEqual(input.payload.access);
    expect(result.access.policyDigest).toBe(operatorPolicyBinding(policy));
    expect(policy.localOperator!.ticketDigest).toBe(operatorTicketDigest(result.access));
    expect(result.catalogPlan).toMatchObject({server: original.database.host, targetDatabase: original.database.database,
      adminUser: input.payload.bootstrap.manifest.adminUser, maximumAuditConnections: 6, builtinManifestSha256: catalogDigest(loadCatalogBuiltins()),
      querySetSha256: CATALOG_QUERY_SET_SHA256, bootstrapOwnerSet: {schema: 1, kind: "temporary-owner-set-v1", authoritySha256: input.authoritySha256},
      limits: {rowsPerQuery: CATALOG_ROW_LIMIT, bytesPerQuery: CATALOG_QUERY_BYTES, bytesPerSnapshot: CATALOG_SNAPSHOT_BYTES}});
  });

  it("feeds ten commands through session validation and the catalog frame without the signing key or new-role passwords", () => {
    const result = prepareTrialCatalogPayload(fixture()), {catalogPlan, ...payload} = result;
    const parsed = trialSessionInput.parse(payload);
    expect(() => validateCatalogCommands(parsed)).not.toThrow();
    const prepared = prepareTrialSession(parsed, clock);
    expect(prepared.requests).toEqual(parsed.requests);
    expect(readTrialPolicy(prepared.common.environment).localOperator!.catalogPlanDigest).toBe(catalogDigest(catalogPlan));
    const frame = catalogStartSchema.parse({type: "catalog_start", schema: 1, environment: result.environment, access: result.access,
      azureCliPython: result.azureCliPython, recoveryDirectory: result.recoveryDirectory, databaseWindow: result.databaseWindow, catalogPlan,
      admin: {adminUrl: result.bootstrap.credentials.adminUrl, adminUser: result.bootstrap.manifest.adminUser}, bootstrapBinding: catalogBootstrapBinding(parsed)});
    expect(frame.bootstrapBinding).toMatch(/^[a-f0-9]{64}$/);
    expect(frame).not.toHaveProperty("signingPrivateKey");
    expect(frame).not.toHaveProperty("bootstrap.credentials");
  });

  it("accepts the signed catalog in the real audit constructor and denies plan substitution before any connection", async () => {
    const result = prepareTrialCatalogPayload(fixture()), controller = new AbortController();
    const access = new CatalogAccess(result.environment, result.access, result.databaseWindow, controller.signal, clock);
    const connect = vi.fn(async () => {throw Error("DB must not open");}), getToken = vi.fn(async () => {throw Error("no token");});
    try {
      const audit = new CatalogAudit(result.catalogPlan, loadCatalogBuiltins(), access, result.bootstrap.credentials.adminUrl, result.recoveryDirectory, {getToken}, connect);
      await audit.close();
      for (const changed of [{...result.catalogPlan, excludedDatabases: []}, {...result.catalogPlan, bootstrapOwnerSet: {...result.catalogPlan.bootstrapOwnerSet!, authoritySha256: "0".repeat(64)}}]) {
        expect(() => new CatalogAudit(changed, loadCatalogBuiltins(), access, result.bootstrap.credentials.adminUrl, result.recoveryDirectory, {getToken}, connect)).toThrow();
      }
      expect(connect).not.toHaveBeenCalled(); expect(getToken).not.toHaveBeenCalled();
    } finally {access.dispose();}
  });

  it("drops exactly four ordered status tails from fourteen while preserving all ten business requests", () => {
    const input = fixture(), ten = structuredClone(input.payload.requests);
    input.payload.requests.push(...input.payload.bootstrap.manifest.cases.map(c => ({command: "status", caseId: c.id})));
    const result = prepareTrialCatalogPayload(input);
    expect(result.requests).toEqual(ten); expect(result.requests).toHaveLength(10);
    expect(input.payload.requests).toHaveLength(14);
  });

  it.each(["business-command", "different-case", "reordered-case", "extra-key"])("cannot discard a tail containing %s", mode => {
    const input = fixture();
    input.payload.requests.push(...input.payload.bootstrap.manifest.cases.map(c => ({command: "status", caseId: c.id})));
    const bad = input.payload.requests[10] as Record<string, unknown>;
    if (mode === "business-command") bad.command = "package-import";
    else if (mode === "different-case") bad.caseId = 99;
    else if (mode === "reordered-case") [input.payload.requests[10], input.payload.requests[11]] = [input.payload.requests[11], input.payload.requests[10]];
    else bad.unapproved = true;
    expect(() => prepareTrialCatalogPayload(input)).toThrow();
  });

  it.each([9, 11, 12, 13, 15, 16])("refuses %s commands rather than removing business work", count => {
    const input = fixture();
    while (input.payload.requests.length < count) input.payload.requests.push({command: "status", caseId: 1});
    input.payload.requests.length = count;
    expect(() => prepareTrialCatalogPayload(input)).toThrow();
  });

  it.each(["missing-ledger", "missing-package", "sample-case", "setting-case", "result-index", "result-field"])("refuses changed business sequence: %s", mode => {
    const input = fixture(), req = input.payload.requests as Record<string, unknown>[];
    if (mode === "missing-ledger") req[0].command = "status";
    else if (mode === "missing-package") req[1].command = "package-preview";
    else if (mode === "sample-case") req[2].caseId = 2;
    else {
      const setting = req[3].setting as Record<string, unknown>;
      if (mode === "setting-case") setting.caseId = 2;
      else setting.source = {$sessionResult: {requestIndex: mode === "result-index" ? 4 : 2, field: mode === "result-field" ? "base" : "source"}};
    }
    expect(() => prepareTrialCatalogPayload(input)).toThrow();
  });

  it.each(["signature", "ticket", "other-key", "policy-tamper"])("refuses altered existing authority: %s", mode => {
    const input = fixture();
    if (mode === "signature") input.payload.environment.TRIAL_POLICY_SIGNATURE = "A".repeat(86) + "==";
    else if (mode === "ticket") input.payload.access.packages = [];
    else if (mode === "other-key") input.payload.signingPrivateKey = otherKey.export({type: "pkcs8", format: "pem"}).toString();
    else {const policy = JSON.parse(input.payload.environment.TRIAL_POLICY_JSON); policy.database.database = "changed"; input.payload.environment.TRIAL_POLICY_JSON = JSON.stringify(policy);}
    expect(() => prepareTrialCatalogPayload(input)).toThrow();
  });

  it("omits temporary membership authority unless selected and still signs the resulting exact plan", () => {
    const input = fixture(); input.temporaryOwnerSet = false;
    const result = prepareTrialCatalogPayload(input);
    expect(result.catalogPlan).not.toHaveProperty("bootstrapOwnerSet");
    expect(readTrialPolicy(result.environment).localOperator!.catalogPlanDigest).toBe(catalogDigest(result.catalogPlan));
  });

  it.each(["duplicate", "postgres", "target", "connectable"])("refuses an invalid excluded-database set: %s", mode => {
    const input = fixture();
    if (mode === "duplicate") input.excludedDatabases.push({...input.excludedDatabases[0]});
    else if (mode === "postgres") input.excludedDatabases[0].name = "postgres";
    else if (mode === "target") input.excludedDatabases[0].name = "trial_fixture";
    else Object.assign(input.excludedDatabases[0], {allowConnect: true});
    expect(() => prepareTrialCatalogPayload(input)).toThrow();
  });

  it("refuses extra producer authority fields and malformed authority references", () => {
    expect(() => prepareTrialCatalogPayload({...fixture(), approved: true})).toThrow();
    expect(() => prepareTrialCatalogPayload({...fixture(), authoritySha256: "owner-approved"})).toThrow();
  });
});
