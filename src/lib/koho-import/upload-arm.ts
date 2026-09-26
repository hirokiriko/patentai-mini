import { requireManual } from "./manual-cli-config";
import { kohoUploadIntentSchema, type KohoUploadIntent } from "./upload-contract";
import { managedBudgetBindingEnvironment } from "../patent-watch/managed-budget-contract";
import type { KohoUploadStorage } from "./upload-storage";

export type KohoUploadArm = (url: string, method: "GET" | "POST", body?: unknown) => Promise<{ status: number; body: unknown }>;
const VERSION = "2025-07-01";
export function kohoUploadJobTemplate(value: KohoUploadIntent) {
  const i = kohoUploadIntentSchema.parse(value), s = i.settings;
  requireManual(i.serviceBudget);
  return { containers: [{ name: "koho-upload", image: s.job.image,
    command: ["node", ".koho-ops/managed/scripts/koho-upload-cloud.js"], args: [], resources: { cpu: 2, memory: "4Gi" }, env: [
      { name: "KOHO_UPLOAD_INTENT_JSON", value: JSON.stringify(i) },
      { name: "KOHO_CLOUD_DATABASE_PASSWORD", secretRef: s.job.databaseSecretRef },
      ...managedBudgetBindingEnvironment(s.budgetBinding),
    ] }], initContainers: [] };
}

/** App identity only; no CLI, login cache or management credential in the app. */
export function uploadManagedArm(resourceId: string, signal: AbortSignal, env = process.env): KohoUploadArm {
  const endpoint = new URL(env.IDENTITY_ENDPOINT ?? "");
  requireManual(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
    endpoint.pathname === "/msi/token" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && env.IDENTITY_HEADER);
  endpoint.searchParams.set("api-version", "2019-08-01"); endpoint.searchParams.set("resource", "https://management.azure.com/");
  if (env.MANAGED_BUDGET_IDENTITY_CLIENT_ID) {
    requireManual(/^[a-f0-9-]{36}$/i.test(env.MANAGED_BUDGET_IDENTITY_CLIENT_ID));
    endpoint.searchParams.set("client_id", env.MANAGED_BUDGET_IDENTITY_CLIENT_ID);
  }
  return async (url, method, body) => {
    const target = new URL(url), prefix = `https://management.azure.com${resourceId}`;
    requireManual(target.origin === "https://management.azure.com" && !target.username && !target.password && !target.hash &&
      (url === `${prefix}?api-version=${VERSION}` || url === `${prefix}/start?api-version=${VERSION}` ||
        (method === "GET" && target.searchParams.get("api-version") === VERSION &&
          [...target.searchParams.keys()].every(k => ["api-version", "$skipToken"].includes(k)) && url.length <= 4096 &&
          (target.pathname === `${resourceId}/executions` || (target.pathname.startsWith(`${resourceId}/executions/`) &&
            /^[a-z0-9-]{1,100}$/.test(target.pathname.slice(`${resourceId}/executions/`.length)))))) &&
      (method === "POST") === (target.pathname === `${resourceId}/start`));
    const tokenResponse = await fetch(endpoint, { headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER! },
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    requireManual(tokenResponse.ok);
    const tokenReader = tokenResponse.body?.getReader(); requireManual(tokenReader);
    const tokenParts: Uint8Array[] = []; let tokenBytes = 0;
    try { for (;;) { const part = await tokenReader.read(); if (part.done) break;
      tokenBytes += part.value.length; requireManual(tokenBytes <= 64 * 1024); tokenParts.push(part.value); } }
    finally { void tokenReader.cancel().catch(() => undefined); tokenReader.releaseLock(); }
    const token = JSON.parse(Buffer.concat(tokenParts).toString("utf8")) as { access_token?: string; resource?: string; expires_on?: string };
    requireManual(typeof token.access_token === "string" && token.access_token.length > 0 && token.access_token.length < 32768 &&
      token.resource === "https://management.azure.com/" && Number(token.expires_on) * 1000 > Date.now() + 30_000);
    const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const reader = response.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
    try { if (reader) for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length;
      requireManual(size <= 1024 ** 2); parts.push(r.value); } }
    finally { if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
    return { status: response.status, body: size ? JSON.parse(Buffer.concat(parts).toString("utf8")) : null };
  };
}

export async function startKohoUpload(store: KohoUploadStorage, id: string, arm: KohoUploadArm) {
  let saved = await store.read(id); const s = saved.state, c = s.intent.settings;
  if (s.startClaimed) return store.reconciled(id);
  requireManual(s.status === "uploaded" && s.source);
  await store.seal(id); // Also confirms a lost budget stage ACK without committing bytes again.
  saved = await store.read(id);
  const url = `https://management.azure.com${c.job.resourceId}`;
  const response = await arm(`${url}?api-version=${VERSION}`, "GET");
  const value = response.body as { id?: string; properties?: { environmentId?: string; configuration?: { triggerType?: string;
    replicaTimeout?: number; replicaRetryLimit?: number; manualTriggerConfig?: { parallelism?: number; replicaCompletionCount?: number } };
    template?: { containers?: Array<{ image?: string }> } } };
  const config = value?.properties?.configuration, containers = value?.properties?.template?.containers;
  requireManual(response.status === 200 && value.id?.toLowerCase() === c.job.resourceId.toLowerCase() &&
    value.properties?.environmentId === c.environmentResourceId && config?.triggerType === "Manual" && config.replicaRetryLimit === 0 &&
    config.replicaTimeout === 7200 && config.manualTriggerConfig?.parallelism === 1 && config.manualTriggerConfig.replicaCompletionCount === 1 &&
    containers?.length === 1 && containers[0].image === c.job.image);
  saved = await store.replace(saved, { ...saved.state, status: "submitting", startClaimed: true });
  try {
    await store.budget.claimUpload(saved.state.intent, "start");
    const started = await arm(`${url}/start?api-version=${VERSION}`, "POST", kohoUploadJobTemplate(saved.state.intent));
    const execution = started.body as { name?: unknown; id?: unknown };
    requireManual([200, 202].includes(started.status) && typeof execution?.name === "string" &&
      /^[a-z0-9-]{1,100}$/.test(execution.name) && execution.name.startsWith(c.job.name + "-") && execution.id === `${c.job.resourceId}/executions/${execution.name}`);
    // A separate receipt cannot race the worker's processing/complete state CAS.
    await store.recordExecution(id, execution.name);
    return store.reconciled(id);
  } catch {
    await store.budget.markUnknown(id).catch(() => undefined);
    const latest = await store.read(id);
    // A worker's durable result is stronger evidence than a lost management ACK.
    if (["processing", "complete", "failed"].includes(latest.state.status)) return latest.state;
    return (await store.replace(latest, { ...latest.state, status: "outcome_unknown", error: "outcome_unknown" })).state;
  }
}
