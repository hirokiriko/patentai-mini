import { managedCloudFixture } from "./managed-cloud.test-support";
import { managedBudgetPolicySchema, managedBudgetTargetDigest } from "./managed-budget-policy";

export function managedBudgetPolicyFixture() {
  const c = managedCloudFixture(), policy = managedBudgetPolicySchema.parse({ schema: 1, serviceKey: "patentai-standard-managed-watch",
    targets: { ownerBindingHash: "8".repeat(64), jobResourceId: c.jobResourceId,
      environmentResourceId: c.jobResourceId.replace("/jobs/fictional-manual", "/managedEnvironments/fictional"),
      storageAccount: "fictional", container: "private-import", managedIdentityClientId: null,
      artifactStorage: { storageAccount: "fictional", container: "private-artifacts" },
      watchTarget: c.target, importTarget: { ...c.target, user: "fictional_import" }, watchAi: c.ai, watchSecrets: c.secrets,
      importDatabaseSecretRef: "fictional-import-db" }, codeSha: c.codeSha, image: c.image,
    validFrom: "2026-09-01T00:00:00Z", validUntil: "2026-09-30T15:00:00Z", measurementDigest: "9".repeat(64),
    reservations: { watchJobYen: 10, watchRunYen: 400, importJobYen: 50, importGiBYen: 40,
      deliveryYen: 50, backupYen: 50, recoveryYen: 500 } });
  const binding = { storageAccount: policy.targets.storageAccount, container: policy.targets.container,
    ownerBindingHash: policy.targets.ownerBindingHash, targetBindingHash: managedBudgetTargetDigest(policy.targets) };
  return { policy, binding };
}
