import { afterEach, describe, expect, it, vi } from "vitest";
import { readTrialPolicy, trialWindow, trialConfigured, trialPolicySchema, assertTrialDatabase, TRIAL_START, TRIAL_END } from "./policy";
import { trialFixture, signedTrialEnvironment, trialHeaders } from "./policy.test-support";
import { trialRoute } from "./routes";
import { withOwnerRoute } from "../owner-http";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function install() {
  const env = signedTrialEnvironment();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  for (const key of Object.keys(process.env)) if (key.startsWith("OWNER_")) vi.stubEnv(key, undefined);
  vi.useFakeTimers(); vi.setSystemTime(new Date(TRIAL_START));
  return env;
}
describe("trial signed policy and deployment boundary", () => {
  it("verifies the signature and refuses edited dates, target, signature or missing mode", () => {
    const env = signedTrialEnvironment();
    expect(readTrialPolicy(env)).toEqual(trialFixture);
    for (const patch of [{ DEPLOYMENT_KIND: undefined }, { TRIAL_POLICY_SIGNATURE: "A".repeat(86) + "==" },
      { TRIAL_POLICY_JSON: env.TRIAL_POLICY_JSON.replace("fictional_trial", "another_database") }])
      expect(() => readTrialPolicy({ ...env, ...patch })).toThrow("trial_unavailable");
    expect(trialConfigured({ TRIAL_POLICY_JSON: "" })).toBe(true);
    expect(trialConfigured({})).toBe(false);
  });
  it("never receives production identity, broad account key, API key or paid OCR credentials", () => {
    const env = signedTrialEnvironment();
    for (const key of ["OWNER_OBJECT_ID", "AZURE_API_KEY", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_DOCUMENT_INTELLIGENCE_KEY"])
      expect(() => readTrialPolicy({ ...env, [key]: "fictional-sentinel" })).toThrow("trial_unavailable");
  });
  it("binds a fixed database, LOGIN and TLS options before any connection", () => {
    const env = signedTrialEnvironment();
    expect(() => assertTrialDatabase(trialFixture, env.DATABASE_URL)).not.toThrow();
    for (const url of [env.DATABASE_URL.replace("fictional_trial", "fictional_production"),
      env.DATABASE_URL.replace("trial_web", "administrator"), env.DATABASE_URL + "&options=unsafe", env.DATABASE_URL + "&sslmode=disable", env.DATABASE_URL.replace("verify-full", "disable")])
      expect(() => assertTrialDatabase(trialFixture, url)).toThrow("trial_unavailable");
  });
  it("does not treat UUID letter case as a separate managed identity", () => {
    const clientId = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    expect(trialPolicySchema.safeParse({ ...trialFixture, identity: { webClientId: clientId, workerClientId: clientId.toUpperCase() } }).success).toBe(false);
  });
  it("uses an inclusive start and exclusive end without resetting on access", () => {
    const start = Date.parse(TRIAL_START), end = Date.parse(TRIAL_END);
    expect(trialWindow(trialFixture, start - 1)).toBe("before");
    expect(trialWindow(trialFixture, start)).toBe("active");
    expect(trialWindow(trialFixture, end - 1)).toBe("active");
    expect(trialWindow(trialFixture, end)).toBe("ended");
    expect(trialWindow(trialFixture, end + 1)).toBe("ended");
    expect(trialPolicySchema.safeParse({ ...trialFixture, endsAt: "2026-11-01T00:00:00Z" }).success).toBe(false);
    expect(trialPolicySchema.safeParse({ ...trialFixture, phase: "initial", startsAt: "2026-10-10T00:00:00Z", endsAt: "2026-10-10T00:30:00Z" }).success).toBe(true);
    expect(trialPolicySchema.safeParse({ ...trialFixture, phase: "initial", startsAt: "2026-10-10T00:00:00Z", endsAt: "2026-10-10T00:30:01Z" }).success).toBe(false);
  });
});
describe("trial route and response authorization", () => {
  it.each(["/admin/koho-updates", "/api/admin/anything", "/api/cases/1/queries", "/api/cases/1/watch", "/api/cases/1/prior-art", "/api/future", "/cases/1/watch/period-report", "/api/cases/%31"])("denies every method of %s", path => {
    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"]) expect(trialRoute(path, method)).toBeNull();
  });
  it("denies implicit HEAD/OPTIONS, deletion and managed settings", () => {
    for (const method of ["HEAD", "OPTIONS", "DELETE", "PUT"]) expect(trialRoute("/api/cases/1", method)).toBeNull();
    expect(trialRoute("/api/cases/1/managed-watch", "PUT")).toBeNull();
    expect(trialRoute("/api/health", "HEAD")?.kind).toBe("health");
    expect(trialRoute("/api/cases/1/draft/2/extract", "POST")?.caseId).toBe(1);
  });
  it("rejects an unauthenticated request, route params mismatch or expiry before the handler", async () => {
    install(); const handler = vi.fn(async (request: Request, context: { params: Promise<{ caseId: string }> }) => { void request; void context; return Response.json({ private: true }); });
    const route = withOwnerRoute(handler), url = `${trialFixture.auth.origin}/api/cases/1`;
    expect((await route(new Request(url), { params: Promise.resolve({ caseId: "1" }) })).status).toBe(401);
    expect((await route(new Request(url, { headers: trialHeaders() }), { params: Promise.resolve({ caseId: "2" }) })).status).toBe(403);
    vi.setSystemTime(new Date(TRIAL_END));
    expect((await route(new Request(url, { headers: trialHeaders() }), { params: Promise.resolve({ caseId: "1" }) })).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
  it("allows settlement to finish while withholding an expired response", async () => {
    install(); const settled = vi.fn();
    const route = withOwnerRoute(async (request: Request) => { void request; vi.setSystemTime(new Date(TRIAL_END)); settled(); return Response.json({ data: "FICTIONAL_PRIVATE_RESULT" }); });
    const response = await route(new Request(`${trialFixture.auth.origin}/api/cases`, { headers: trialHeaders() }));
    expect(settled).toHaveBeenCalledOnce(); expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("FICTIONAL_PRIVATE_RESULT");
  });
});
