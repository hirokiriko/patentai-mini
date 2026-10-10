import { generateKeyPairSync, sign } from "node:crypto";
import { trialPolicyBytes, type TrialPolicy, TRIAL_START, TRIAL_END, TRIAL_RETENTION_REVIEW } from "./policy";

export const trialFixture: TrialPolicy = {
  schema: 1, approval: "LIGHTWEIGHT_GROUP_TRIAL_V3", phase: "trial", startsAt: TRIAL_START, endsAt: TRIAL_END,
  retentionReviewAt: TRIAL_RETENTION_REVIEW, codeSha: "a".repeat(40),
  auth: { tenantId: "11111111-1111-4111-8111-111111111111", ownerId: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333", origin: "https://trial.fictional.invalid" },
  database: { host: "fictional.postgres.database.azure.com", port: 5432, database: "fictional_trial", webUser: "trial_web", workerUser: "trial_worker" },
  storage: { account: "fictionaltrial", originals: "trial-originals", artifacts: "trial-artifacts", budget: "trial-budget" },
  identity: { webClientId: "44444444-4444-4444-8444-444444444444", workerClientId: "55555555-5555-4555-8555-555555555555" },
  ai: { resourceName: "fictional-ai", normalDeployment: "fictional-normal", miniDeployment: "fictional-mini", apiVersion: "v1" },
  jobResourceId: "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fictional/providers/Microsoft.App/jobs/trial-job",
  environmentResourceId: "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fictional/providers/Microsoft.App/managedEnvironments/shared",
  samples: [{ caseId: 1, from: "2026-01-01", through: "2026-01-31" }],
};
export function signedTrialEnvironment(policy = trialFixture) {
  const keys = generateKeyPairSync("ed25519");
  return { DEPLOYMENT_KIND: "trial", TRIAL_POLICY_JSON: JSON.stringify(policy),
    TRIAL_POLICY_PUBLIC_KEY: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    TRIAL_POLICY_SIGNATURE: sign(null, trialPolicyBytes(policy), keys.privateKey).toString("base64"),
    DATABASE_URL: `postgresql://${policy.database.webUser}:fictional-only@${policy.database.host}:5432/${policy.database.database}?sslmode=verify-full` };
}
export function trialHeaders() {
  const a = trialFixture.auth;
  return new Headers({ origin: a.origin, "x-ms-client-principal": Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [
    { typ: "oid", val: a.ownerId }, { typ: "tid", val: a.tenantId }, { typ: "aud", val: a.clientId },
    { typ: "iss", val: `https://login.microsoftonline.com/${a.tenantId}/v2.0` },
  ] })).toString("base64") });
}
