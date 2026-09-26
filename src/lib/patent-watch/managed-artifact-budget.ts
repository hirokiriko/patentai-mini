import { readFile } from "node:fs/promises";
import { cloudTargetSchema } from "../koho-import/cloud-config";
import { managedArtifactContextSchema, type ManagedArtifactAdmission, type ManagedArtifactContext } from "./managed-artifact-contract";
import { ManagedServiceBudgetStorage } from "./managed-service-budget-storage";
import { ManagedBudgetError } from "./managed-service-budget";

export function managedArtifactDatabaseTarget(connectionString: string) {
  try {
    const url = new URL(connectionString);
    // pg gives query parameters precedence over authority/path. Permit only
    // TLS parameters, never a hidden host/user/port/database/options override.
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash ||
      [...url.searchParams.keys()].some(key => !["sslmode", "sslrootcert"].includes(key)) ||
      [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1) ||
      (url.searchParams.has("sslmode") && !["require", "verify-full"].includes(url.searchParams.get("sslmode")!))) throw Error();
    return cloudTargetSchema.parse({ host: url.hostname, port: Number(url.port || process.env.PGPORT || 5432),
      database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username) });
  } catch { throw new ManagedBudgetError(); }
}

/** Called only for a new execution. Historical reads need neither current prices
 * nor an installed budget credential. Never return a URL/password in diagnostics. */
export function configuredManagedArtifactAdmission(verifiedTarget?: ManagedArtifactContext["target"]): ManagedArtifactAdmission {
  return async (intent, containerUrl, deadline) => {
    try {
      deadline.throwIfAborted();
      let target = verifiedTarget;
      if (!target) {
        target = managedArtifactDatabaseTarget(process.env.DATABASE_URL ?? "");
      }
      const codeSha = (await readFile(".managed-build-sha", { encoding: "utf8", signal: deadline })).trim();
      const context = managedArtifactContextSchema.parse({ approval: process.env.MANAGED_ARTIFACT_APPROVAL, target, codeSha, containerUrl });
      await ManagedServiceBudgetStorage.configured().withDeadline(deadline).admitArtifact(intent, context);
      deadline.throwIfAborted();
    } catch { throw new ManagedBudgetError(); }
  };
}
