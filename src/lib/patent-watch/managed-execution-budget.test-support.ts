import { sha256 } from "../koho-import/cloud-config";
import { managedBudgetPolicyFixture } from "./managed-budget-policy.test-support";
import { managedBudgetTargetDigest } from "./managed-budget-policy";
import { managedBudgetBindingSchema } from "./managed-budget-contract";
import { managedCloudFixture } from "./managed-cloud.test-support";
import { parseManagedCloudStartConfiguration, type ManagedCloudConfiguration } from "./managed-cloud-config";
import { managedWatchBudgetRequest } from "./managed-execution-budget";

/** Call after the real test DB target/run snapshot is finalized. Legacy fixtures
 * intentionally retain their old serialized shape for status/hash regression. */
export function managedBudgetedWatchFixture(config: ManagedCloudConfiguration = managedCloudFixture()) {
  const { policy } = managedBudgetPolicyFixture();
  config = { ...config, expectedEnvironmentResourceId:config.expectedEnvironmentResourceId ?? policy.targets.environmentResourceId };
  policy.targets.watchTarget = config.target;
  policy.targets.importTarget = { ...config.target, user: "fictional_import" };
  policy.targets.watchAi = config.ai; policy.targets.watchSecrets = config.secrets;
  policy.targets.jobResourceId = config.jobResourceId; policy.codeSha = config.codeSha; policy.image = config.image;
  const binding = managedBudgetBindingSchema.parse({ storageAccount: policy.targets.storageAccount, container: policy.targets.container,
    ownerBindingHash: policy.targets.ownerBindingHash, targetBindingHash: managedBudgetTargetDigest(policy.targets) });
  const pricingDigest = sha256(JSON.stringify(policy)), profileDigest = config.approval === "STANDARD_MANAGED_WATCH_STANDARD_V1" ? "d".repeat(64) : null;
  const request = managedWatchBudgetRequest(config, policy, binding, pricingDigest, profileDigest);
  return { policy, binding, pricingDigest, request, config: parseManagedCloudStartConfiguration({ ...config, budgetBinding: binding,
    serviceBudget: { serviceKey: policy.serviceKey, requestDigest: request.requestDigest, profileDigest, pricingDigest } }) };
}
