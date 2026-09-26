import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { managedCloudFixture } from "./managed-cloud.test-support";
import { managedBudgetedWatchFixture } from "./managed-execution-budget.test-support";
import { managedBudgetBindingEnvironment } from "./managed-budget-contract";
import { managedCloudConfigSchema } from "./managed-cloud-config";

const fake = vi.hoisted(() => ({ readFile: vi.fn(), history: vi.fn(), run: vi.fn(), inspect: vi.fn(), prepare: vi.fn(),
  dispatch: vi.fn(), reconcile: vi.fn(), get: vi.fn(), arm: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: fake.readFile }));
vi.mock("../../repositories/managed-watch", () => ({ ManagedWatchRepository: class { history = fake.history; run = fake.run; } }));
vi.mock("../../repositories/managed-cloud-start", () => ({ ManagedCloudStartRepository: class { get = fake.get; } }));
vi.mock("./managed-service-budget-storage", () => ({ ManagedServiceBudgetStorage: { configured: () => ({ withDeadline: () => ({
  inspectWebWatchReservation: fake.inspect, prepareWebWatch: fake.prepare,
}) }) } }));
vi.mock("./managed-cloud-dispatch", () => ({ dispatchManagedWatch: fake.dispatch, reconcileManagedWatchStart: fake.reconcile }));
vi.mock("../koho-import/upload-arm", () => ({ uploadManagedArm: () => fake.arm }));
import { configuredManagedWebWatch, webManagedWatch } from "./managed-web-watch";

const cloud = managedCloudFixture(), binding = managedBudgetedWatchFixture(cloud).binding;
const settings = managedCloudConfigSchema.omit({ operationId: true, runs: true, expiresAt: true, budgetProof: true }).strip().parse(cloud);
const installed = { ...settings, budgetBinding: binding,
  expectedEnvironmentResourceId: cloud.jobResourceId.replace(/\/jobs\/[^/]+$/, "/managedEnvironments/fictional") };
const connection = "postgresql://fictional_app:FICTIONAL_PASSWORD@fictional.postgres.database.azure.com:5432/fictional?sslmode=verify-full";
const db = {} as NodePgDatabase<typeof schema>;
beforeEach(() => {
  vi.clearAllMocks(); fake.readFile.mockResolvedValue(cloud.codeSha);
  for (const e of managedBudgetBindingEnvironment(binding)) vi.stubEnv(e.name, e.value);
  vi.stubEnv("DATABASE_URL", connection); vi.stubEnv("MANAGED_WATCH_WEB_SETTINGS", JSON.stringify(installed));
  fake.history.mockResolvedValue([{ runId: cloud.runs[0].runId, status: "prepared", startReservationId: null }]);
  fake.inspect.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

it("accepts the exact installed DB target and build", async () => {
  expect((await configuredManagedWebWatch()).target).toEqual(cloud.target);
});
it.each(["host=other.postgres.database.azure.com", "user=other", "port=6432", "dbname=other", "options=-csearch_path=other",
  "sslmode=disable", "sslmode=require&sslmode=verify-full"])("rejects pg connection overrides before any repository or ARM call: %s", async query => {
  vi.stubEnv("DATABASE_URL", connection.split("?")[0] + "?" + query);
  await expect(configuredManagedWebWatch()).rejects.toThrow();
  expect(fake.history).not.toHaveBeenCalled(); expect(fake.arm).not.toHaveBeenCalled();
});
it("matches the port pg obtains from PGPORT when the URL omits it", async () => {
  vi.stubEnv("DATABASE_URL", connection.replace(":5432/", "/")); vi.stubEnv("PGPORT", "6432");
  await expect(configuredManagedWebWatch()).rejects.toThrow();
});
it.each(["budget_reserved", "outcome_unknown"])("reconciles %s without creating another config or dispatch", async state => {
  fake.inspect.mockResolvedValue(state);
  for (const action of ["start", "reconcile"] as const) {
    expect(await webManagedWatch(db, 7, cloud.runs[0].runId, action, AbortSignal.timeout(1000)))
      .toEqual({ operationId: cloud.runs[0].runId, status: state });
  }
  expect(fake.prepare).not.toHaveBeenCalled(); expect(fake.dispatch).not.toHaveBeenCalled(); expect(fake.arm).not.toHaveBeenCalled();
});
it("reports an unreserved prepared run as not started without a write", async () => {
  expect(await webManagedWatch(db, 7, cloud.runs[0].runId, "reconcile", AbortSignal.timeout(1000)))
    .toEqual({ operationId: cloud.runs[0].runId, status: "not_started" });
  expect(fake.prepare).not.toHaveBeenCalled(); expect(fake.dispatch).not.toHaveBeenCalled();
});
