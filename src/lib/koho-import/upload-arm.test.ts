import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadManagedArm } from "./upload-arm";

const job = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fictional/providers/Microsoft.App/jobs/fictional-job";
const appIdentity = "22222222-2222-4222-8222-222222222222";
const workerIdentity = "33333333-3333-4333-8333-333333333333";
const env = { NODE_ENV: "test" as const, IDENTITY_ENDPOINT: "http://127.0.0.1:12345/msi/token", IDENTITY_HEADER: "FICTIONAL_IDENTITY_HEADER",
  MANAGED_BUDGET_IDENTITY_CLIENT_ID: workerIdentity };
afterEach(() => vi.unstubAllGlobals());

describe("App identity for managed Job requests", () => {
  it.each([appIdentity, undefined])("uses only the configured App identity (%s)", async identity => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return requests.length === 1 ? Response.json({ access_token: "FICTIONAL_ARM_TOKEN",
        resource: "https://management.azure.com/", expires_on: String(Math.floor(Date.now() / 1000) + 120) }) :
        Response.json({ id: job });
    }));
    const arm = uploadManagedArm(job, new AbortController().signal,
      { ...env, ...(identity ? { MANAGED_ARM_IDENTITY_CLIENT_ID: identity } : {}) });
    expect(await arm(`https://management.azure.com${job}?api-version=2025-07-01`, "GET"))
      .toEqual({ status: 200, body: { id: job } });
    const tokenUrl = new URL(requests[0].url);
    expect(tokenUrl.searchParams.get("client_id")).toBe(identity ?? null);
    expect(tokenUrl.searchParams.get("client_id")).not.toBe(workerIdentity);
    expect(tokenUrl.searchParams.get("resource")).toBe("https://management.azure.com/");
    expect(requests).toHaveLength(2);
    expect(requests[1].init?.method).toBe("GET");
  });
  it("rejects an invalid App identity before requesting any token", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => uploadManagedArm(job, new AbortController().signal,
      { ...env, MANAGED_ARM_IDENTITY_CLIENT_ID: "f".repeat(36) })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
