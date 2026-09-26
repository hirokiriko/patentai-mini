import { readFile } from "node:fs/promises";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { ManagedWatchRepository } from "../../repositories/managed-watch";
import { ManagedCloudStartRepository } from "../../repositories/managed-cloud-start";
import { managedCloudConfigSchema } from "./managed-cloud-config";
import { managedBudgetBindingSchema, managedBudgetBindingFromEnvironment } from "./managed-budget-contract";
import { managedDigest } from "./managed-claims";
import { ManagedWatchError, isUnchangedManagedSnapshot } from "./managed-types";
import { ManagedServiceBudgetStorage } from "./managed-service-budget-storage";
import { dispatchManagedWatch, reconcileManagedWatchStart } from "./managed-cloud-dispatch";
import { uploadManagedArm } from "../koho-import/upload-arm";
import { cloudEnvironmentResourceIdSchema } from "../koho-import/cloud-config";
import { managedArtifactDatabaseTarget } from "./managed-artifact-budget";

export const managedWebWatchSettingsSchema = managedCloudConfigSchema.omit({ operationId: true, runs: true, expiresAt: true,
  budgetProof: true, serviceBudget: true, budgetBinding: true, expectedEnvironmentResourceId: true }).extend({
  budgetBinding: managedBudgetBindingSchema, expectedEnvironmentResourceId: cloudEnvironmentResourceIdSchema,
}).strict();
export async function configuredManagedWebWatch(env = process.env) {
  const raw = env.MANAGED_WATCH_WEB_SETTINGS;
  if (!raw || Buffer.byteLength(raw) > 32_768 || !env.DATABASE_URL) throw new ManagedWatchError("unavailable");
  const c = managedWebWatchSettingsSchema.parse(JSON.parse(raw));
  const target = managedArtifactDatabaseTarget(env.DATABASE_URL);
  if ((await readFile(".managed-build-sha", "utf8")).trim() !== c.codeSha ||
    managedDigest(c.budgetBinding) !== managedDigest(managedBudgetBindingFromEnvironment(env)) ||
    managedDigest(target) !== managedDigest(c.target)) throw new ManagedWatchError("unavailable");
  return c;
}
/** The run UUID is also its unique one-Job start UUID. Reloads recover it from
 * the DB, not browser memory; an uncertain reservation never creates a new ID. */
export async function webManagedWatch(db: NodePgDatabase<typeof schema>, caseId: number, runId: string, action: "start" | "reconcile", deadline: AbortSignal) {
  const c = await configuredManagedWebWatch();
  if (!c.caseAllowList.includes(caseId)) throw new ManagedWatchError("not_found");
  const watch = new ManagedWatchRepository(db), starts = new ManagedCloudStartRepository(db);
  const row = (await watch.history(caseId)).find(r => r.runId === runId);
  if (!row) throw new ManagedWatchError("not_found");
  const arm = uploadManagedArm(c.jobResourceId, deadline);
  if (row.startReservationId) {
    const existing = await starts.get(row.startReservationId);
    if (existing.config.jobResourceId !== c.jobResourceId || !existing.config.runs.some(r => r.caseId === caseId && r.runId === runId) ||
      existing.config.runs.some(r => !c.caseAllowList.includes(r.caseId))) throw new ManagedWatchError("incomplete");
    if (action === "reconcile") return reconcileManagedWatchStart(starts, row.startReservationId, arm);
    return { operationId: row.startReservationId, status: existing.status };
  }
  if (row.status !== "prepared") throw new ManagedWatchError("conflict");
  const budget = ManagedServiceBudgetStorage.configured().withDeadline(deadline);
  // A stopped request may have reserved money before committing the DB start.
  // Read that exact operation first; a fresh expiry must never replace its intent.
  const reservation = await budget.inspectWebWatchReservation(runId, caseId, c.caseAllowList);
  if (reservation) return { operationId: runId, status: reservation };
  if (action === "reconcile") return { operationId: runId, status: "not_started" as const };
  const run = await watch.run(caseId, runId);
  const config = await budget.prepareWebWatch({ ...c, operationId: runId, runs: [{ caseId, runId, snapshotDigest: run.snapshotDigest,
    ...(isUnchangedManagedSnapshot(run.snapshot) ? { mode: "no_change_only" as const } : {}) }],
    expiresAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString() });
  return dispatchManagedWatch(starts, config, arm, budget);
}
