import { readFile } from "node:fs/promises";
import { BlobServiceClient } from "@azure/storage-blob";
import { managedBudgetBindingFromEnvironment } from "../patent-watch/managed-budget-contract";
import { ManagedServiceBudgetStorage } from "../patent-watch/managed-service-budget-storage";
import { managedDigest } from "../patent-watch/managed-claims";
import { cloudManagedIdentity } from "./cloud-blob";
import { requireManual } from "./manual-cli-config";
import { kohoUploadSettingsSchema, type KohoUploadSettings } from "./upload-contract";
import { KohoUploadStorage } from "./upload-storage";

const options = { retryOptions: { maxTries: 1, tryTimeoutInMs: 20_000 } };
export async function configuredKohoUpload(signal: AbortSignal, env: Record<string, string | undefined> = process.env) {
  const raw = env.MANAGED_KOHO_UPLOAD_SETTINGS;
  requireManual(raw && Buffer.byteLength(raw) <= 32_768);
  const settings = kohoUploadSettingsSchema.parse(JSON.parse(raw!));
  const binding = managedBudgetBindingFromEnvironment(env);
  requireManual(managedDigest(binding) === managedDigest(settings.budgetBinding) &&
    (await readFile(".managed-build-sha", "utf8")).trim() === settings.codeSha && env.AZURE_STORAGE_CONNECTION_STRING);
  signal.throwIfAborted();
  const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING!, options);
  return new KohoUploadStorage(settings, service.getContainerClient(binding.container),
    ManagedServiceBudgetStorage.configured(env).withDeadline(signal), signal);
}

/** The fixed Job receives only its import password and injected managed identity. */
export function workerKohoUpload(value: KohoUploadSettings, signal: AbortSignal, env: Record<string, string | undefined> = process.env) {
  const settings = kohoUploadSettingsSchema.parse(value), binding = managedBudgetBindingFromEnvironment(env);
  requireManual(managedDigest(binding) === managedDigest(settings.budgetBinding));
  const identity = cloudManagedIdentity(binding, env, signal);
  const service = new BlobServiceClient(`https://${binding.storageAccount}.blob.core.windows.net`, identity, options);
  return new KohoUploadStorage(settings, service.getContainerClient(binding.container),
    ManagedServiceBudgetStorage.withIdentity(binding, identity).withDeadline(signal), signal);
}
