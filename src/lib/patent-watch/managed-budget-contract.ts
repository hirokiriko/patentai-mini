import { z } from "zod";
import { MANAGED_SERVICE_KEY, ManagedBudgetError } from "./managed-service-budget";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const managedBudgetBindingSchema = z.object({ storageAccount: z.string().regex(/^[a-z0-9]{3,24}$/),
  container: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).refine(v => !v.includes("--")),
  targetBindingHash: hash, ownerBindingHash: hash, managedIdentityClientId: z.uuid().optional() }).strict();
export type ManagedBudgetBinding = z.infer<typeof managedBudgetBindingSchema>;
export const managedBudgetReferenceSchema = z.object({ serviceKey: z.literal(MANAGED_SERVICE_KEY),
  requestDigest: hash, profileDigest: hash.nullable(), pricingDigest: hash }).strict();
export type ManagedBudgetReference = z.infer<typeof managedBudgetReferenceSchema>;
export const managedExecutionApprovalSchema = z.enum(["STANDARD_MANAGED_WATCH_RELEASE_V1", "STANDARD_MANAGED_WATCH_STANDARD_V1"]);
export function isManagedExecutionApproval(value: string): value is z.infer<typeof managedExecutionApprovalSchema> {
  return value === "STANDARD_MANAGED_WATCH_RELEASE_V1" || value === "STANDARD_MANAGED_WATCH_STANDARD_V1";
}
/** Only the installed operator environment supplies these values. The worker
 * receives the same fixed values in the persisted execution template. */
export function managedBudgetBindingFromEnvironment(env: Record<string, string | undefined> = process.env): ManagedBudgetBinding {
  try { return managedBudgetBindingSchema.parse({ storageAccount: env.MANAGED_BUDGET_STORAGE_ACCOUNT,
    container: env.MANAGED_BUDGET_CONTAINER, targetBindingHash: env.MANAGED_BUDGET_TARGET_SHA256,
    ownerBindingHash: env.MANAGED_BUDGET_OWNER_SHA256,
    ...(env.MANAGED_BUDGET_IDENTITY_CLIENT_ID ? { managedIdentityClientId: env.MANAGED_BUDGET_IDENTITY_CLIENT_ID } : {}) });
  } catch { throw new ManagedBudgetError(); }
}
export function managedBudgetBindingEnvironment(value: ManagedBudgetBinding) {
  const b = managedBudgetBindingSchema.parse(value);
  return [{ name: "MANAGED_BUDGET_STORAGE_ACCOUNT", value: b.storageAccount }, { name: "MANAGED_BUDGET_CONTAINER", value: b.container },
    { name: "MANAGED_BUDGET_TARGET_SHA256", value: b.targetBindingHash }, { name: "MANAGED_BUDGET_OWNER_SHA256", value: b.ownerBindingHash },
    ...(b.managedIdentityClientId ? [{ name: "MANAGED_BUDGET_IDENTITY_CLIENT_ID", value: b.managedIdentityClientId }] : [])];
}
