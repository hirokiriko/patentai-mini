import { readTrialPolicy, requireTrialActive, trialPolicyDigest, TrialError, type TrialPolicy } from "./policy";
import { trialIdentity, type TrialRole } from "./identity";

export function trialAiTarget(policy: TrialPolicy, role: "normal" | "fast", url: string, init: RequestInit | undefined) {
  const expected = new URL(`https://${policy.ai.resourceName}.openai.azure.com/openai/v1/responses`);
  expected.searchParams.set("api-version", policy.ai.apiVersion);
  if (url !== expected.href || init?.method !== "POST" || typeof init.body !== "string") throw new TrialError();
  const body = JSON.parse(init.body);
  if (body.model !== (role === "normal" ? policy.ai.normalDeployment : policy.ai.miniDeployment)) throw new TrialError();
}

/** Passed underneath the durable budget, so no token wait can extend send permission. */
export function trialAiTransport(role: "normal" | "fast", runtimeRole: TrialRole,
  transport: typeof fetch = globalThis.fetch): typeof fetch {
  const policy = readTrialPolicy(), digest = trialPolicyDigest(policy);
  const identity = trialIdentity(policy, runtimeRole, "https://cognitiveservices.azure.com/");
  return async (url, init) => {
    try {
      const target = String(url);
      const captured = init ? { ...init, headers: new Headers(init.headers) } : undefined;
      trialAiTarget(policy, role, target, captured);
      requireTrialActive(policy);
      const token = await identity.getToken();
      const current = readTrialPolicy();
      if (trialPolicyDigest(current) !== digest) throw new TrialError();
      requireTrialActive(current);
      captured?.signal?.throwIfAborted();
      const headers = new Headers(captured?.headers);
      headers.delete("api-key"); headers.delete("authorization");
      headers.set("Authorization", `Bearer ${token.token}`);
      return await transport(target, { ...captured, headers, redirect: "error" });
    } catch { throw new TrialError("trial_ai_unavailable"); }
  };
}
