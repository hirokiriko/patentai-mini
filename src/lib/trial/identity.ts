import { TrialError, type TrialEnvironment, type TrialPolicy } from "./policy";

export type TrialRole = "web" | "worker";
export type TrialAudience = "https://storage.azure.com/" | "https://cognitiveservices.azure.com/" | "https://management.azure.com/";

/** ACA's injected identity endpoint is the sole credential chain. */
export function trialIdentity(policy: TrialPolicy, role: TrialRole, audience: TrialAudience,
  env: TrialEnvironment = process.env, transport: typeof fetch = globalThis.fetch) {
  let endpoint: URL;
  const clientId = role === "web" ? policy.identity.webClientId : policy.identity.workerClientId;
  try {
    endpoint = new URL(env.IDENTITY_ENDPOINT ?? "");
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.pathname !== "/msi/token" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !env.IDENTITY_HEADER || env.IDENTITY_HEADER.length > 32_768) throw new TrialError();
    endpoint.searchParams.set("api-version", "2019-08-01");
    endpoint.searchParams.set("resource", audience);
    endpoint.searchParams.set("client_id", clientId);
  } catch { throw new TrialError(); }
  let cached: { token: string; expiresOnTimestamp: number } | undefined;
  return { async getToken() {
    if (cached && cached.expiresOnTimestamp > Date.now() + 120_000) return cached;
    try {
      const response = await transport(endpoint, { redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER! } });
      if (!response.ok || !response.body) throw new TrialError();
      const reader = response.body.getReader(), parts: Uint8Array[] = [];
      let length = 0;
      try { for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength; if (length > 65_536) throw new TrialError(); parts.push(next.value);
      } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      const expiresOnTimestamp = Number(value.expires_on) * 1000;
      if (typeof value.access_token !== "string" || value.access_token.length < 1 || value.access_token.length > 32_768 ||
        /\s/.test(value.access_token) || value.token_type !== "Bearer" || value.resource !== audience ||
        value.client_id?.toLowerCase() !== clientId.toLowerCase() || !Number.isFinite(expiresOnTimestamp) ||
        expiresOnTimestamp < Date.now() + 30_000) throw new TrialError();
      cached = { token: value.access_token, expiresOnTimestamp }; return cached;
    } catch { throw new TrialError("trial_identity_unavailable"); }
  } };
}
