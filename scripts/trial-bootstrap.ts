import { z } from "zod";
import { bootstrapTrialDatabase, bootstrapManifestSchema, bootstrapCredentialsSchema } from "../src/lib/trial/bootstrap";
import { OperatorAccess, operatorTicketSchema } from "../src/lib/trial/operator-access";
import { readTrialPolicy, TrialError } from "../src/lib/trial/policy";
import { verifyTrialBuild } from "../src/lib/trial/runtime";
import type { CatalogBootstrapCapability } from "../src/lib/trial/catalog-runtime";

import { trialAzureCliPythonSchema, trialOwnerCredential } from "./trial-owner-token";

export const trialBootstrapInput = z.object({
  azureCliPython: trialAzureCliPythonSchema, environment: z.record(z.string(), z.string()), access: operatorTicketSchema, recoveryDirectory: z.string(),
  manifest: bootstrapManifestSchema, credentials: bootstrapCredentialsSchema, mode: z.enum(["apply", "reconcile"]),
}).strict();

/** Protected stdin only; this entry never resolves a management secret or
 * generates credentials. The launcher binds the saved normal admin credential. */
export async function runTrialBootstrap(value: unknown, beforeFirstWrite?:()=>Promise<CatalogBootstrapCapability>) {
  const input = trialBootstrapInput.parse(value);
  const allowed = new Set(["DEPLOYMENT_KIND", "TRIAL_POLICY_JSON", "TRIAL_POLICY_SIGNATURE", "TRIAL_POLICY_PUBLIC_KEY"]);
  if (Object.keys(input.environment).some(k => !allowed.has(k))) throw new TrialError("trial_bootstrap_environment_invalid");
  const policy = readTrialPolicy(input.environment), access = new OperatorAccess(input.access, policy);
  try {
    access.check(5 * 60_000);
    await verifyTrialBuild(policy);
    const credential = trialOwnerCredential(policy, access, input.azureCliPython);
    return await bootstrapTrialDatabase({ policy, access, manifest: input.manifest, credentials: input.credentials,
      recoveryDirectory: input.recoveryDirectory, mode: input.mode, credential, beforeFirstWrite });
  } finally { access.dispose(); }
}

if (require.main === module) {
  let chunks: Buffer[] = [], size = 0;
  process.stdin.on("data", chunk => { const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 131072) { chunks = []; process.stdin.destroy(); process.exitCode = 1; }
    else chunks.push(bytes);
  });
  process.stdin.on("end", () => { void (async () => {
    try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); chunks = [];
      const { receipts, ...result } = await runTrialBootstrap(value); void receipts; process.stdout.write(JSON.stringify(result) + "\n");
    } catch { process.stderr.write("trial_bootstrap_unconfirmed\n"); process.exitCode = 1; }
  })(); });
  process.stdin.on("error", () => { chunks = []; process.exitCode = 1; });
}
