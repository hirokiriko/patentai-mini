import { expect, it } from "vitest";
import { managedBudgetPolicyFixture } from "./managed-budget-policy.test-support";
import { managedBudgetPolicySchema, managedBudgetTargetDigest, validateManagedBudgetPolicy } from "./managed-budget-policy";
import { managedBudgetBindingEnvironment, managedBudgetBindingFromEnvironment } from "./managed-budget-contract";

const at = new Date("2026-09-23T00:00:00Z"), duration = 120 * 60_000;
it("pins Azure v1 exactly and refuses changing a version under an installed target binding", () => {
  const f = managedBudgetPolicyFixture();
  f.policy.targets.watchAi.apiVersion = "v1";
  f.binding.targetBindingHash = managedBudgetTargetDigest(f.policy.targets);
  expect(validateManagedBudgetPolicy(f.policy, f.binding, at, duration).targets.watchAi.apiVersion).toBe("v1");
  f.policy.targets.watchAi.apiVersion = "2025-04-01-preview";
  expect(() => validateManagedBudgetPolicy(f.policy, f.binding, at, duration)).toThrow("managed_budget_stopped");
});
it("keeps one installed target binding across code and price revisions", () => {
  const f = managedBudgetPolicyFixture();
  expect(validateManagedBudgetPolicy(f.policy, f.binding, at, duration)).toEqual(f.policy);
  const next = { ...f.policy, codeSha: "f".repeat(40), reservations: { ...f.policy.reservations, watchRunYen: 500 } };
  expect(managedBudgetTargetDigest(next.targets)).toBe(f.binding.targetBindingHash);
  expect(validateManagedBudgetPolicy(next, f.binding, at, duration)).toEqual(next);
});
it.each(["target", "owner", "container", "identity", "future", "expired", "action", "window"])("stops a %s mismatch before a quote can be used", reason => {
  const f = managedBudgetPolicyFixture();
  if (reason === "target") f.binding.targetBindingHash = "f".repeat(64);
  if (reason === "owner") f.binding.ownerBindingHash = "f".repeat(64);
  if (reason === "container") f.binding.container = "other-private";
  if (reason === "identity") f.policy.targets.managedIdentityClientId = "11111111-1111-4111-8111-111111111111";
  if (reason === "future") f.policy.validFrom = "2026-09-24T00:00:00Z";
  if (reason === "expired") f.policy.validUntil = "2026-09-23T01:00:00Z";
  if (reason === "window") f.policy.validUntil = "2026-11-01T00:00:00Z";
  expect(() => validateManagedBudgetPolicy(f.policy, f.binding, at, reason === "action" ? 0 : duration)).toThrow("managed_budget_stopped");
});
it("keeps import and watch logins and secret references separate on the same approved database", () => {
  const { policy } = managedBudgetPolicyFixture();
  expect(() => managedBudgetPolicySchema.parse({ ...policy, targets: { ...policy.targets, importTarget: policy.targets.watchTarget } })).toThrow();
  expect(() => managedBudgetPolicySchema.parse({ ...policy, targets: { ...policy.targets, importDatabaseSecretRef: policy.targets.watchSecrets.database } })).toThrow();
  expect(() => managedBudgetPolicySchema.parse({ ...policy, targets: { ...policy.targets, importTarget: { ...policy.targets.importTarget, database: "other_db" } } })).toThrow();
});
it("round-trips only non-secret fixed binding environment values", () => {
  const { binding } = managedBudgetPolicyFixture(), env = Object.fromEntries(managedBudgetBindingEnvironment(binding).map(v => [v.name, v.value]));
  expect(managedBudgetBindingFromEnvironment(env)).toEqual(binding);
  expect(JSON.stringify(env)).not.toMatch(/CONNECTION_STRING|PRIVATE_KEY|SECRET|PASSWORD/);
  delete env.MANAGED_BUDGET_TARGET_SHA256;
  expect(() => managedBudgetBindingFromEnvironment(env)).toThrow("managed_budget_stopped");
});
