import { z } from "zod";
import { cloudTargetSchema, cloudEnvironmentResourceIdSchema } from "../koho-import/cloud-config";
import { managedHash, managedId, ManagedWatchError } from "./managed-types";
import { managedExecutionApprovalSchema, managedBudgetReferenceSchema, managedBudgetBindingSchema, managedBudgetBindingEnvironment } from "./managed-budget-contract";
export const managedCloudConfigSchema = z.object({ approval: managedExecutionApprovalSchema, operationId: z.uuidv4(),
  codeSha: z.string().regex(/^[a-f0-9]{40}$/), image: z.string().regex(/^[a-z0-9]+\.azurecr\.io\/patentai-mini@sha256:[a-f0-9]{64}$/),
  jobName: z.string().regex(/^[a-z][a-z0-9-]{1,58}[a-z0-9]$/),
  jobResourceId: z.string().regex(/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z0-9-]{1,60}$/),
  target: cloudTargetSchema, expiresAt: z.iso.datetime(),
  caseAllowList: z.array(managedId).min(1).max(5),
  runs: z.array(z.object({ caseId: managedId, runId: z.uuidv4(), snapshotDigest: managedHash,
    mode: z.literal("no_change_only").optional() }).strict()).min(1).max(3),
  ai: z.object({ resourceName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/), deployment: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    apiVersion: z.string().regex(/^(?:v1|\d{4}-\d{2}-\d{2}(?:-preview)?)$/) }).strict(),
  secrets: z.object({ database: z.string().regex(/^[a-z0-9-]{1,64}$/), ai: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict(),
  budgetProof: z.object({ ledgerDigest: managedHash, checkedAt: z.iso.datetime(), additionalForecastYen: z.number().int().positive().max(50_000),
    monthlyForecastYen: z.number().int().positive().max(30_000), externalJobExecutions: z.number().int().nonnegative().max(24),
    externalJobReservedMinutes: z.number().int().nonnegative().max(48*60), externalNormalSends: z.number().int().nonnegative().max(900),
    externalFastSends: z.number().int().nonnegative().max(80) }).strict(),
  // No defaults: historical serialized configurations and template hashes remain unchanged.
  serviceBudget: managedBudgetReferenceSchema.optional(), budgetBinding: managedBudgetBindingSchema.optional(),
  expectedEnvironmentResourceId: cloudEnvironmentResourceIdSchema.optional(),
}).strict();
export type ManagedCloudConfiguration = z.infer<typeof managedCloudConfigSchema>;
export function parseManagedCloudConfiguration(value: unknown, now = Date.now(), requireFreshBudget = true): ManagedCloudConfiguration {
  const c = managedCloudConfigSchema.parse(value);
  if (!c.jobResourceId.endsWith(`/jobs/${c.jobName}`) || new Set(c.caseAllowList).size !== c.caseAllowList.length ||
    new Set(c.runs.map(r=>r.caseId)).size !== c.runs.length || new Set(c.runs.map(r=>r.runId)).size !== c.runs.length ||
    c.runs.some(r=>!c.caseAllowList.includes(r.caseId)) || Date.parse(c.expiresAt) <= now || Date.parse(c.expiresAt) - now > 6*60*60_000 ||
    Date.parse(c.budgetProof.checkedAt) > now + 60_000 || (requireFreshBudget && now - Date.parse(c.budgetProof.checkedAt) > 30*60_000)) throw new ManagedWatchError("invalid_setting");
  return c;
}
export function parseManagedCloudStartConfiguration(value: unknown, now = Date.now(), requireFreshBudget = true) {
  const c = parseManagedCloudConfiguration(value, now, requireFreshBudget);
  if (!c.serviceBudget || !c.budgetBinding || !c.expectedEnvironmentResourceId ||
    (c.approval === "STANDARD_MANAGED_WATCH_STANDARD_V1") !== (c.serviceBudget.profileDigest !== null)) throw new ManagedWatchError("invalid_setting");
  return { ...c, serviceBudget: c.serviceBudget, budgetBinding: c.budgetBinding, expectedEnvironmentResourceId:c.expectedEnvironmentResourceId };
}
export type ManagedCloudStartConfiguration = ReturnType<typeof parseManagedCloudStartConfiguration>;
/** Only this fixed template may be sent by the operator. No inherited import credential. */
export function managedWatchJobTemplate(value: ManagedCloudConfiguration, freshDispatch = true) {
  const c = freshDispatch ? parseManagedCloudStartConfiguration(value) : managedCloudConfigSchema.parse(value);
  return { containers: [{ name: "managed-watch", image: c.image, command: ["node", ".koho-ops/managed/scripts/managed-watch-cloud.js"], args: [],
    resources: { cpu: 2, memory: "4Gi" }, env: [
      { name: "MANAGED_WATCH_CONFIG_JSON", value: JSON.stringify(c) },
      { name: "MANAGED_WATCH_DATABASE_PASSWORD", secretRef: c.secrets.database },
      { name: "AZURE_API_KEY", secretRef: c.secrets.ai },
      { name: "AI_PROVIDER", value: "azure" }, { name: "AZURE_RESOURCE_NAME", value: c.ai.resourceName },
      { name: "AZURE_OPENAI_DEPLOYMENT_NAME", value: c.ai.deployment }, { name: "AZURE_OPENAI_API_VERSION", value: c.ai.apiVersion },
      ...(c.budgetBinding ? managedBudgetBindingEnvironment(c.budgetBinding) : []),
    ] }], initContainers: [] };
}
