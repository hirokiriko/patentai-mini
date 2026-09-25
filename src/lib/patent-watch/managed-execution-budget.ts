import { z } from "zod";
import { managedCloudConfigSchema } from "./managed-cloud-config";
import { parseCloudConfiguration, parseCloudManifest, isManagedCloudConfiguration, isManagedCloudManifest, sha256 } from "../koho-import/cloud-config";
import { managedDigest } from "./managed-claims";
import { managedBudgetPolicySchema, managedBudgetTargetDigest, type ManagedBudgetPolicy } from "./managed-budget-policy";
import { managedBudgetBindingSchema, type ManagedBudgetBinding } from "./managed-budget-contract";
import { emptyManagedBudgetUnits, managedBudgetRequestSchema, ManagedBudgetError } from "./managed-service-budget";
import { managedArtifactIntentSchema, managedArtifactContextSchema } from "./managed-artifact-contract";

export const managedImportJobSchema = z.object({ resourceId: managedCloudConfigSchema.shape.jobResourceId,
  name: managedCloudConfigSchema.shape.jobName, image: managedCloudConfigSchema.shape.image,
  databaseSecretRef: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict();
export type ManagedImportJob = z.infer<typeof managedImportJobSchema>;
const check = (value: unknown) => { if (!value) throw new ManagedBudgetError(); };
const same = (a: unknown, b: unknown) => managedDigest(a) === managedDigest(b);
function policy(value: ManagedBudgetPolicy, fixed: ManagedBudgetBinding) {
  const p = managedBudgetPolicySchema.parse(value), b = managedBudgetBindingSchema.parse(fixed);
  check(managedBudgetTargetDigest(p.targets) === b.targetBindingHash && p.targets.ownerBindingHash === b.ownerBindingHash &&
    p.targets.storageAccount === b.storageAccount && p.targets.container === b.container &&
    p.targets.managedIdentityClientId === (b.managedIdentityClientId ?? null));
  return p;
}
function reference(approval: string, profileDigest: string | null) {
  const standard = approval === "STANDARD_MANAGED_WATCH_STANDARD_V1";
  check(standard ? profileDigest !== null : profileDigest === null);
  return { scope: standard ? "standard" as const : "release" as const, profileDigest };
}
/** Fixed reservations include the existing maximum output/read sizes. The DB
 * still seals the exact artifact hashes; a result never rewrites this intent. */
export function managedArtifactBudgetRequest(value: unknown, context: unknown, approvedPolicy: ManagedBudgetPolicy,
  binding: ManagedBudgetBinding, pricingDigest: string, profileDigest: string | null) {
  binding = managedBudgetBindingSchema.parse(binding);
  const intent = managedArtifactIntentSchema.parse(value), c = managedArtifactContextSchema.parse(context), p = policy(approvedPolicy, binding);
  const destination = p.targets.artifactStorage;
  check(c.codeSha === p.codeSha && same(c.target, p.targets.watchTarget) &&
    c.containerUrl === `https://${destination.storageAccount}.blob.core.windows.net/${destination.container}`);
  if (intent.kind === "recovery") check(intent.recoveryOperationId !== intent.backupId);
  const operationId = intent.kind === "delivery" ? intent.deliveryId : intent.kind === "backup" ? intent.backupId : intent.recoveryOperationId;
  return managedBudgetRequestSchema.parse({ operationId,
    requestDigest: managedDigest({ schema: 1, intent, context: c, budgetBinding: binding }),
    ...reference(c.approval, profileDigest), kind: intent.kind, pricingDigest, cases: [intent.caseId],
    reservationYen: p.reservations[`${intent.kind}Yen`], units: emptyManagedBudgetUnits() });
}
/** Recomputed by operator and worker. Caller-written totals and the reference
 * itself do not determine the intent, reservation amount, or operation units. */
export function managedWatchBudgetRequest(value: unknown, approvedPolicy: ManagedBudgetPolicy, binding: ManagedBudgetBinding,
  pricingDigest: string, profileDigest: string | null) {
  binding = managedBudgetBindingSchema.parse(binding);
  const c = managedCloudConfigSchema.parse(value), p = policy(approvedPolicy, binding);
  check(c.jobResourceId === p.targets.jobResourceId && c.jobResourceId.endsWith(`/jobs/${c.jobName}`) &&
    c.expectedEnvironmentResourceId === p.targets.environmentResourceId &&
    c.codeSha === p.codeSha && c.image === p.image && same(c.target, p.targets.watchTarget) &&
    same(c.ai, p.targets.watchAi) && same(c.secrets, p.targets.watchSecrets));
  const { budgetProof, serviceBudget, budgetBinding, ...business } = c;
  void budgetProof; void serviceBudget; void budgetBinding;
  const requestDigest = managedDigest({ schema: 1, kind: "watch", configuration: business, budgetBinding: binding });
  return managedBudgetRequestSchema.parse({ operationId: c.operationId, requestDigest, ...reference(c.approval, profileDigest),
    kind: "watch", pricingDigest, cases: c.caseAllowList,
    reservationYen: p.reservations.watchJobYen + c.runs.length * p.reservations.watchRunYen,
    units: { ...emptyManagedBudgetUnits(), jobs: 1, minutes: 120, starts: c.runs.length, normal: 41 * c.runs.length } });
}
export function managedImportBudgetRequest(value: unknown, manifestValue: unknown, jobValue: unknown,
  approvedPolicy: ManagedBudgetPolicy, binding: ManagedBudgetBinding, pricingDigest: string, profileDigest: string | null) {
  binding = managedBudgetBindingSchema.parse(binding);
  const c = parseCloudConfiguration(value), job = managedImportJobSchema.parse(jobValue), p = policy(approvedPolicy, binding);
  if (!isManagedCloudConfiguration(c)) throw new ManagedBudgetError();
  const bytes = Buffer.from(JSON.stringify(manifestValue)); check(bytes.length <= 131072);
  const m = parseCloudManifest(bytes, { ...c, manifest: { ...c.manifest, byteLength: bytes.length, sha256: sha256(bytes) } }, Date.now(), false);
  check(c.storageAccount === p.targets.storageAccount && c.container === p.targets.container &&
    (c.managedIdentityClientId ?? null) === p.targets.managedIdentityClientId && same(c.expectedTarget, p.targets.importTarget) &&
    c.expectedEnvironmentResourceId === p.targets.environmentResourceId && c.expectedCodeSha === p.codeSha &&
    job.resourceId === p.targets.jobResourceId && job.resourceId.endsWith(`/jobs/${job.name}`) && job.image === p.image &&
    job.databaseSecretRef === p.targets.importDatabaseSecretRef);
  const { serviceBudget, budgetBinding, manifest, ...business } = c;
  void serviceBudget; void budgetBinding; void manifest;
  // Sealing stage changes only package ETags and the manifest reference. All
  // publication, plan, provenance, deadline, and fixed Job fields stay bound.
  const packages = m.packages.map(pkg => { const { etag, ...identity } = pkg; void etag; return identity; });
  let requestDigest = managedDigest({ schema: 1, kind: "import", configuration: business,
    manifest: { ...m, packages }, job, budgetBinding: binding });
  const size = m.packages.reduce((n, pkg) => n + pkg.byteLength, 0);
  check(isManagedCloudManifest(m));
  if (!isManagedCloudManifest(m)) throw new ManagedBudgetError();
  const archiveOnly = m.archiveOnly === true, fromArchives = m.packages.every(pkg => pkg.archive);
  if (archiveOnly) {
    const pkg = m.packages[0];
    // A new UUID, acquisition timestamp, code version or month cannot purchase
    // a second reservation for the same canonical source. Reuse its receipt.
    requestDigest = managedDigest({ schema: 1, kind: "archive", budgetBinding: binding, source: {
      packageType: pkg.packageType, issueNumber: pkg.issueNumber, publicationDate: pkg.publicationDate,
      distributionTableSha256: pkg.distributionTableSha256, sha256: pkg.sha256, byteLength: pkg.byteLength } });
  }
  if (archiveOnly) check(p.reservations.archivePackageYen !== undefined && p.reservations.archiveGiBYen !== undefined);
  const reservationYen = archiveOnly ? p.reservations.archivePackageYen! + Math.ceil(size / 1024 ** 3) * p.reservations.archiveGiBYen! :
    p.reservations.importJobYen + (fromArchives ? 0 : Math.ceil(size / 1024 ** 3) * p.reservations.importGiBYen);
  return managedBudgetRequestSchema.parse({ operationId: c.operationId, requestDigest, ...reference(c.approval, profileDigest),
    kind: "import", pricingDigest, cases: [], reservationYen,
    units: { ...emptyManagedBudgetUnits(), jobs: archiveOnly ? 0 : 1, minutes: archiveOnly ? 0 : 120,
      packages: fromArchives ? 0 : m.packages.length, bytes: fromArchives ? 0 : size } });
}
