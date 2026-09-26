import { readFile } from "node:fs/promises";
import { kohoUploadIntentSchema } from "../src/lib/koho-import/upload-contract";
import { workerKohoUpload } from "../src/lib/koho-import/upload-config";
import { runKohoUpload } from "../src/lib/koho-import/upload-runtime";

/** Fixed mode of the existing Manual Job; no CLI or app DB credential fallback. */
export async function kohoUploadCloudMain(env = process.env, argv = process.argv) {
  const signal = AbortSignal.timeout(119 * 60_000);
  try {
    if (argv.length !== 2 || !env.KOHO_UPLOAD_INTENT_JSON || Buffer.byteLength(env.KOHO_UPLOAD_INTENT_JSON) > 32768) throw Error();
    const intent = kohoUploadIntentSchema.parse(JSON.parse(env.KOHO_UPLOAD_INTENT_JSON));
    const password = env.KOHO_CLOUD_DATABASE_PASSWORD;
    delete env.KOHO_UPLOAD_INTENT_JSON; delete env.KOHO_CLOUD_DATABASE_PASSWORD;
    const execution = env.CONTAINER_APP_JOB_EXECUTION_NAME;
    if (!password || env.CONTAINER_APP_JOB_NAME !== intent.settings.job.name || !execution ||
      !execution.startsWith(intent.settings.job.name + "-") || !/^[a-z0-9-]{1,100}$/.test(execution) ||
      (await readFile(".managed-build-sha", "utf8")).trim() !== intent.settings.codeSha ||
      env.DATABASE_URL || env.MANAGED_WATCH_DATABASE_PASSWORD || env.AZURE_API_KEY || env.AZURE_STORAGE_CONNECTION_STRING) throw Error();
    return await runKohoUpload(intent, workerKohoUpload(intent.settings, signal, env), password, signal);
  } catch { return { status: "reconciliation_required", exitCode: 2 }; }
}
if (require.main === module) {
  let printed = false;
  const stop = () => { if (!printed) process.stdout.write('{"status":"reconciliation_required"}\n'); process.exit(2); };
  const watchdog = setTimeout(stop, 120 * 60_000); process.on("SIGTERM", stop); process.on("SIGINT", stop);
  void kohoUploadCloudMain().then(result => {
    printed = true; process.stdout.write(JSON.stringify({ status: result.status }) + "\n"); process.exitCode = result.exitCode;
  }).finally(() => { clearTimeout(watchdog); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); });
}
