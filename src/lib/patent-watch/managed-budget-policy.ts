import { z } from "zod";
import { cloudTargetSchema } from "../koho-import/cloud-config";
import { managedCloudConfigSchema } from "./managed-cloud-config";
import { managedDigest } from "./managed-claims";
import { managedBudgetBindingSchema, type ManagedBudgetBinding } from "./managed-budget-contract";
import { MANAGED_SERVICE_KEY, ManagedBudgetError } from "./managed-service-budget";
import { managedWatchAiRatesSchema } from "./managed-watch-cost";

const hash = z.string().regex(/^[a-f0-9]{64}$/), yen = z.number().int().nonnegative().max(30_000);
const targets = z.object({ ownerBindingHash: hash, jobResourceId: managedCloudConfigSchema.shape.jobResourceId,
  environmentResourceId: z.string().regex(/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/managedEnvironments\/[a-zA-Z0-9-]{1,60}$/),
  storageAccount: managedBudgetBindingSchema.shape.storageAccount, container: managedBudgetBindingSchema.shape.container,
  artifactStorage: z.object({ storageAccount: managedBudgetBindingSchema.shape.storageAccount,
    container: managedBudgetBindingSchema.shape.container }).strict(),
  managedIdentityClientId: z.uuid().nullable(), watchTarget: cloudTargetSchema, importTarget: cloudTargetSchema,
  watchAi: managedCloudConfigSchema.shape.ai, watchSecrets: managedCloudConfigSchema.shape.secrets,
  importDatabaseSecretRef: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict().refine(t =>
    t.watchTarget.host === t.importTarget.host && t.watchTarget.database === t.importTarget.database &&
    t.watchTarget.user !== t.importTarget.user && t.watchSecrets.database !== t.importDatabaseSecretRef);
/** One product's reviewed reservation amounts, inclusive of tax and margin.
 * These are conservative reservations, never a claim of measured invoice cost.
 * A month review pins the raw policy bytes; no business request supplies rates. */
export const managedBudgetPolicySchema = z.object({ schema: z.literal(1), serviceKey: z.literal(MANAGED_SERVICE_KEY),
  targets, codeSha: z.string().regex(/^[a-f0-9]{40}$/), image: managedCloudConfigSchema.shape.image,
  validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), measurementDigest: hash,
  watchAiRates: managedWatchAiRatesSchema.optional(),
  reservations: z.object({ watchJobYen: yen, watchRunYen: yen.refine(v => v > 0),
    importJobYen: yen.refine(v => v > 0), importGiBYen: yen, deliveryYen: yen.refine(v => v > 0),
    archivePackageYen: yen.refine(v => v > 0).optional(), archiveGiBYen: yen.optional(),
    backupYen: yen.refine(v => v > 0), recoveryYen: yen.refine(v => v > 0) }).strict() }).strict();
export type ManagedBudgetPolicy = z.infer<typeof managedBudgetPolicySchema>;
export function managedBudgetTargetDigest(value: unknown) { return managedDigest(targets.parse(value)); }
export function validateManagedBudgetPolicy(value: unknown, binding: ManagedBudgetBinding, now: Date, actionMs: number) {
  try {
    const p = managedBudgetPolicySchema.parse(value), b = managedBudgetBindingSchema.parse(binding), at = now.getTime();
    if (managedBudgetTargetDigest(p.targets) !== b.targetBindingHash || p.targets.ownerBindingHash !== b.ownerBindingHash ||
      p.targets.storageAccount !== b.storageAccount || p.targets.container !== b.container ||
      p.targets.managedIdentityClientId !== (b.managedIdentityClientId ?? null) || !Number.isFinite(at) ||
      !Number.isSafeInteger(actionMs) || actionMs <= 0 || actionMs > 6 * 60 * 60_000 ||
      Date.parse(p.validFrom) > at || at + actionMs >= Date.parse(p.validUntil) ||
      Date.parse(p.validUntil) - Date.parse(p.validFrom) > 32 * 24 * 60 * 60_000) throw new ManagedBudgetError();
    return p;
  } catch { throw new ManagedBudgetError(); }
}
