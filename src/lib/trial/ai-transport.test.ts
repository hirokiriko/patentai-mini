import { afterEach, describe, expect, it, vi } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { generateObject } from "ai";
import { z } from "zod";
import { trialAiTarget, trialAiTransport } from "./ai-transport";
import { trialIdentity } from "./identity";
import { trialFixture, signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START, TRIAL_END } from "./policy";
import { boundedAzureFetch, withAiOperationBudget } from "../ai-operation-budget";
import { extractClaims } from "../extract-claims";
import { configuredManagedWebWatch } from "../patent-watch/managed-web-watch";
import { storeOriginalFile } from "../blob-storage";
import { ManagedPrivateStorage } from "../patent-watch/managed-storage";
import { ManagedServiceBudgetStorage } from "../patent-watch/managed-service-budget-storage";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function install() {
  for (const [key, value] of Object.entries(signedTrialEnvironment())) vi.stubEnv(key, value);
  for (const key of Object.keys(process.env)) if (key.startsWith("OWNER_")) vi.stubEnv(key, undefined);
  vi.stubEnv("IDENTITY_ENDPOINT", "http://127.0.0.1:4231/msi/token");
  vi.stubEnv("IDENTITY_HEADER", "fictional-loopback-header");
  vi.useFakeTimers(); vi.setSystemTime(new Date(TRIAL_START));
}
const responseForToken = (role: "web" | "worker" = "web", overrides = {}) => Response.json({
  access_token: "fictional-token", token_type: "Bearer", resource: "https://cognitiveservices.azure.com/",
  client_id: role === "web" ? trialFixture.identity.webClientId : trialFixture.identity.workerClientId,
  expires_on: String(Math.floor(Date.now() / 1000) + 3600), ...overrides,
});
const url = `https://${trialFixture.ai.resourceName}.openai.azure.com/openai/v1/responses?api-version=v1`;
const init = { method: "POST", body: JSON.stringify({ model: trialFixture.ai.normalDeployment }), headers: { "api-key": "" } };

describe("trial Azure token boundary with the installed SDK", () => {
  it("uses the real SDK URL/model and sends only scoped Bearer authentication", async () => {
    install();
    const tokenFetch = vi.fn(async () => responseForToken()); vi.stubGlobal("fetch", tokenFetch);
    const network = vi.fn(async () => Response.json({ id: "resp_fictional", object: "response", created_at: 0,
      model: trialFixture.ai.normalDeployment, status: "completed",
      output: [{ id: "msg_fictional", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
    const provider = createAzure({ resourceName: trialFixture.ai.resourceName, apiVersion: "v1", apiKey: "",
      fetch: trialAiTransport("normal", "web", network) });
    const result = await generateObject({ model: provider(trialFixture.ai.normalDeployment), schema: z.object({ ok: z.boolean() }),
      prompt: "fictional test", maxRetries: 0, maxOutputTokens: 100 });
    expect(result.object.ok).toBe(true); expect(tokenFetch).toHaveBeenCalledTimes(1); expect(network).toHaveBeenCalledTimes(1);
    const sent = network.mock.calls[0] as unknown as [string, RequestInit];
    expect(sent[0]).toBe(url);
    expect(new Headers(sent[1].headers).get("api-key")).toBeNull();
    expect(new Headers(sent[1].headers).get("Authorization")).toBe("Bearer fictional-token");
    expect(sent[1].redirect).toBe("error");
  });
  it.each(["web", "worker"] as const)("selects the signed %s identity", async role => {
    install();
    const request = vi.fn(async () => responseForToken(role));
    await trialIdentity(trialFixture, role, "https://cognitiveservices.azure.com/", process.env, request).getToken();
    const requested = new URL(String((request.mock.calls[0] as unknown[])[0]));
    expect(requested.searchParams.get("client_id")).toBe(role === "web" ? trialFixture.identity.webClientId : trialFixture.identity.workerClientId);
    expect(requested.searchParams.get("resource")).toBe("https://cognitiveservices.azure.com/");
  });
  it("rejects altered host/path/query/model before token acquisition", async () => {
    install(); const tokenFetch = vi.fn(async () => responseForToken()); vi.stubGlobal("fetch", tokenFetch);
    const network = vi.fn(); const send = trialAiTransport("normal", "web", network);
    for (const target of [url.replace("fictional-ai", "other-ai"), url + "&extra=true", url + "&api-version=v1", url.replace("responses", "chat/completions")])
      await expect(send(target, init)).rejects.toThrow("trial_ai_unavailable");
    expect(() => trialAiTarget(trialFixture, "fast", url, init)).toThrow();
    expect(tokenFetch).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it("withholds a new send when the token wait crosses expiry", async () => {
    install(); vi.stubGlobal("fetch", vi.fn(async () => { vi.setSystemTime(new Date(TRIAL_END)); return responseForToken(); }));
    const network = vi.fn();
    await expect(trialAiTransport("normal", "web", network)(url, init)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it("snapshots a mutable URL before waiting for a token", async () => {
    install(); const target = new URL(url);
    vi.stubGlobal("fetch", vi.fn(async () => { target.host = "other.invalid"; return responseForToken(); }));
    const network = vi.fn(async () => new Response());
    await trialAiTransport("normal", "web", network)(target, init);
    expect((network.mock.calls[0] as unknown[])[0]).toBe(url);
  });
  it("rejects another identity, scope, type, short expiry and oversized token responses", async () => {
    install();
    for (const override of [{ client_id: trialFixture.identity.workerClientId }, { resource: "https://management.azure.com/" },
      { token_type: "Other" }, { expires_on: "0" }, { access_token: "x".repeat(65_537) }]) {
      await expect(trialIdentity(trialFixture, "web", "https://cognitiveservices.azure.com/", process.env,
        async () => responseForToken("web", override)).getToken()).rejects.toThrow("trial_identity_unavailable");
    }
  });
  it("refuses non-ACA credential endpoints", () => {
    install();
    for (const endpoint of ["https://example.invalid/msi/token", "http://127.0.0.1/msi/token?resource=other", "http://127.0.0.1/other"])
      expect(() => trialIdentity(trialFixture, "web", "https://cognitiveservices.azure.com/", { ...process.env, IDENTITY_ENDPOINT: endpoint })).toThrow();
  });
  it("does not treat legacy budgets, fallback extraction or production dispatch/storage as trial admission", async () => {
    install(); const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    expect(() => boundedAzureFetch("normal")).toThrow("trial_budget_unavailable");
    await expect(withAiOperationBudget({ normal: 0, fast: 4 }, async () => boundedAzureFetch("fast"))).rejects.toThrow();
    await expect(extractClaims("fictional document")).rejects.toThrow("trial_budget_unavailable");
    await expect(configuredManagedWebWatch()).rejects.toThrow("trial_dispatch_unavailable");
    expect(() => ManagedPrivateStorage.configured()).toThrow("trial_storage_unavailable");
    expect(() => ManagedServiceBudgetStorage.configured()).toThrow("trial_budget_unavailable");
    await expect(storeOriginalFile({ caseId: 1, category: "drafts", fileName: "sample.txt", buffer: Buffer.from("fictional") })).rejects.toThrow("trial_storage_unavailable");
    expect(transport).not.toHaveBeenCalled();
  });
});
