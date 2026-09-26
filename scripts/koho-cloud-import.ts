/** Dedicated bounded manual Job entrypoint. Secrets never arrive through argv or stdout. */
import { parseCloudConfiguration, isManagedCloudConfiguration } from "../src/lib/koho-import/cloud-config";
import { createCloudBlobBoundary, cloudManagedIdentity } from "../src/lib/koho-import/cloud-blob";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import { requireManual } from "../src/lib/koho-import/manual-cli-config";
import { readFile } from "node:fs/promises";
import { ManagedServiceBudgetStorage } from "../src/lib/patent-watch/managed-service-budget-storage";
import { managedBudgetBindingFromEnvironment } from "../src/lib/patent-watch/managed-budget-contract";
import { managedImportJobSchema } from "../src/lib/patent-watch/managed-execution-budget";

if (require.main === module) {
  const controller = new AbortController();
  let printed = false;
  const incomplete = () => { if (!printed) { printed = true; process.stdout.write('{"status":"reconciliation_required","databaseOutcome":"unconfirmed","receiptAcknowledgement":"unconfirmed","cleanup":"required","exitCode":2}\n'); } };
  const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const watchdog = setTimeout(() => { controller.abort(); incomplete(); process.exit(2); }, 120 * 60_000);
  void (async () => {
    try {
      requireManual(process.argv.length === 2 && typeof process.env.KOHO_CLOUD_CONFIG_JSON === "string" && Buffer.byteLength(process.env.KOHO_CLOUD_CONFIG_JSON) <= 32768);
      const config = parseCloudConfiguration(JSON.parse(process.env.KOHO_CLOUD_CONFIG_JSON));
      let budget:NonNullable<Parameters<typeof runCloudImport>[2]>["budget"];
      if (isManagedCloudConfiguration(config)) {
        requireManual((await readFile(".managed-build-sha", "utf8")).trim() === config.expectedCodeSha && !process.env.MANAGED_WATCH_DATABASE_PASSWORD && !process.env.DATABASE_URL);
        requireManual(process.env.MANAGED_IMPORT_JOB_JSON&&Buffer.byteLength(process.env.MANAGED_IMPORT_JOB_JSON)<=4096);
        const job=managedImportJobSchema.parse(JSON.parse(process.env.MANAGED_IMPORT_JOB_JSON!));delete process.env.MANAGED_IMPORT_JOB_JSON;
        requireManual(process.env.CONTAINER_APP_JOB_NAME===job.name);
        const binding=managedBudgetBindingFromEnvironment(),storage=ManagedServiceBudgetStorage.withIdentity(binding,cloudManagedIdentity(binding,process.env,controller.signal));
        budget={verify:(c,m)=>storage.verifyImport(c,m,job)};
      }
      const password = process.env.KOHO_CLOUD_DATABASE_PASSWORD;
      // No generic DATABASE_URL, PG* or provider configuration is consumed by this entrypoint.
      delete process.env.KOHO_CLOUD_CONFIG_JSON; delete process.env.KOHO_CLOUD_DATABASE_PASSWORD;
      const result = await runCloudImport(config, createCloudBlobBoundary(config, controller.signal), { password, signal: controller.signal, budget });
      printed = true; process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.exitCode;
    } catch { incomplete(); process.exitCode = 2; }
    finally { clearTimeout(watchdog); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  })();
}
