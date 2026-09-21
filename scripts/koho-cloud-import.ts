/** Dedicated bounded manual Job entrypoint. Secrets never arrive through argv or stdout. */
import { parseCloudConfiguration } from "../src/lib/koho-import/cloud-config";
import { createCloudBlobBoundary } from "../src/lib/koho-import/cloud-blob";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import { requireManual } from "../src/lib/koho-import/manual-cli-config";

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
      const password = process.env.KOHO_CLOUD_DATABASE_PASSWORD;
      // No generic DATABASE_URL, PG* or provider configuration is consumed by this entrypoint.
      delete process.env.KOHO_CLOUD_CONFIG_JSON; delete process.env.KOHO_CLOUD_DATABASE_PASSWORD;
      const result = await runCloudImport(config, createCloudBlobBoundary(config, controller.signal), { password, signal: controller.signal });
      printed = true; process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.exitCode;
    } catch { incomplete(); process.exitCode = 2; }
    finally { clearTimeout(watchdog); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  })();
}
