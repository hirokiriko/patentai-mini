import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { bootstrapTrialDatabase, bootstrapManifestSchema, bootstrapCredentialsSchema } from "../src/lib/trial/bootstrap";
import { OperatorAccess, operatorTicketSchema } from "../src/lib/trial/operator-access";
import { readTrialPolicy, TrialError } from "../src/lib/trial/policy";
import { verifyTrialBuild } from "../src/lib/trial/runtime";

export const trialBootstrapInput = z.object({
  environment: z.record(z.string(), z.string()), access: operatorTicketSchema, recoveryDirectory: z.string(),
  manifest: bootstrapManifestSchema, credentials: bootstrapCredentialsSchema, mode: z.enum(["apply", "reconcile"]),
}).strict();
const exec = promisify(execFile);

/** Protected stdin only; this entry never resolves a management secret or
 * generates credentials. The launcher binds the saved normal admin credential. */
export async function runTrialBootstrap(value: unknown) {
  const input = trialBootstrapInput.parse(value);
  const allowed = new Set(["DEPLOYMENT_KIND", "TRIAL_POLICY_JSON", "TRIAL_POLICY_SIGNATURE", "TRIAL_POLICY_PUBLIC_KEY"]);
  if (Object.keys(input.environment).some(k => !allowed.has(k))) throw new TrialError("trial_bootstrap_environment_invalid");
  const policy = readTrialPolicy(input.environment), access = new OperatorAccess(input.access, policy);
  try {
    access.check(5 * 60_000);
    await verifyTrialBuild(policy);
    let cached: { token: string; until: number } | undefined;
    const credential = { async getToken() {
      access.check(30_000);
      if (cached && cached.until > Date.now() + 60_000) return { token: cached.token };
      const result = await exec(process.platform === "win32" ? "az.cmd" : "az",
        ["account", "get-access-token", "--resource", "https://storage.azure.com/", "--output", "json", "--only-show-errors"],
        { windowsHide: true, shell: process.platform === "win32", timeout: 30_000, maxBuffer: 65536, signal: access.signal });
      access.check();
      const data = JSON.parse(result.stdout);
      if (typeof data.accessToken !== "string" || data.tenant?.toLowerCase() !== policy.auth.tenantId.toLowerCase()) throw new TrialError();
      const claims = JSON.parse(Buffer.from(data.accessToken.split(".")[1], "base64url").toString("utf8"));
      const until = Number(data.expires_on) * 1000;
      if (claims.oid?.toLowerCase() !== policy.auth.ownerId.toLowerCase() || claims.tid?.toLowerCase() !== policy.auth.tenantId.toLowerCase() ||
        claims.aud?.replace(/\/$/, "") !== "https://storage.azure.com" || !Number.isFinite(until) || until <= Date.now() + 60_000) throw new TrialError();
      cached = { token: data.accessToken, until }; return { token: cached.token };
    } };
    return await bootstrapTrialDatabase({ policy, access, manifest: input.manifest, credentials: input.credentials,
      recoveryDirectory: input.recoveryDirectory, mode: input.mode, credential });
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
      const result = await runTrialBootstrap(value); process.stdout.write(JSON.stringify(result) + "\n");
    } catch { process.stderr.write("trial_bootstrap_unconfirmed\n"); process.exitCode = 1; }
  })(); });
  process.stdin.on("error", () => { chunks = []; process.exitCode = 1; });
}
