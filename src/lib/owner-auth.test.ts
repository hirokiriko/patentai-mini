import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeOwner, ownerAuthConfig, OWNER_CACHE_CONTROL, type OwnerAuthConfig } from "./owner-auth";
import { withOwnerRoute } from "./owner-http";
const config: OwnerAuthConfig = { tenantId: "11111111-1111-1111-1111-111111111111", ownerId: "22222222-2222-2222-2222-222222222222",
  clientId: "33333333-3333-3333-3333-333333333333", origin: "https://fictional.invalid" };
function identity(extra: Array<{ typ: string; val: string }> = []) {
  return { auth_typ: "aad", claims: [{ typ: "oid", val: config.ownerId }, { typ: "tid", val: config.tenantId },
    { typ: "aud", val: config.clientId }, { typ: "iss", val: `https://login.microsoftonline.com/${config.tenantId}/v2.0` }, ...extra] };
}
function headers(principal: unknown = identity(), origin: string | null = config.origin) {
  const result = new Headers({ "x-ms-client-principal": Buffer.from(JSON.stringify(principal)).toString("base64") });
  if (origin) result.set("origin", origin); return result;
}
function env() {
  vi.stubEnv("OWNER_AUTH_MODE", "azure-easy-auth"); vi.stubEnv("OWNER_APP_ORIGIN", config.origin);
  vi.stubEnv("OWNER_TENANT_ID", config.tenantId); vi.stubEnv("OWNER_OBJECT_ID", config.ownerId); vi.stubEnv("OWNER_CLIENT_ID", config.clientId);
}
afterEach(() => vi.unstubAllEnvs());
describe("OWNER authorization behind verified Easy Auth", () => {
  it("fails closed when configuration is missing or origin is not fixed HTTPS", () => {
    expect(ownerAuthConfig({})).toBeNull(); env(); expect(ownerAuthConfig(process.env)).toEqual(config);
    expect(ownerAuthConfig({ ...process.env, OWNER_APP_ORIGIN: "https://fictional.invalid/" })).toBeNull();
    expect(ownerAuthConfig({ ...process.env, OWNER_APP_ORIGIN: "http://fictional.invalid" })).toBeNull();
    expect(authorizeOwner(headers(), "GET", null)).toBe("unavailable");
  });
  it("rejects anonymous, email-only, same-tenant other owner and conflicting claims", () => {
    expect(authorizeOwner(new Headers(), "GET", config)).toBe("unauthenticated");
    expect(authorizeOwner(headers({ auth_typ: "aad", claims: [{ typ: "email", val: "owner@fictional.invalid" }] }), "GET", config)).toBe("forbidden");
    const other = identity(); other.claims[0].val = "44444444-4444-4444-4444-444444444444";
    expect(authorizeOwner(headers(other), "GET", config)).toBe("forbidden");
    expect(authorizeOwner(headers(identity([{ typ: "http://schemas.microsoft.com/identity/claims/objectidentifier", val: other.claims[0].val }])), "GET", config)).toBe("forbidden");
    expect(authorizeOwner(headers(identity([{ typ: "aud", val: other.claims[0].val }])), "GET", config)).toBe("forbidden");
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])("requires exact Origin for %s", method => {
    expect(authorizeOwner(headers(identity(), null), method, config)).toBe("forbidden");
    expect(authorizeOwner(headers(identity(), "https://other.invalid"), method, config)).toBe("forbidden");
    expect(authorizeOwner(headers(), method, config)).toBe("owner");
  });
  it.each(["=", "a".repeat(32772), "eyJ==", "!!!!"])("rejects malformed identity %s", value => {
    expect(authorizeOwner(new Headers({ "x-ms-client-principal": value }), "GET", config)).toBe("forbidden");
  });
  it("rejects external identity contradictions and wrong issuer", () => {
    const h = headers(); h.set("x-ms-client-principal-id", "other");
    expect(authorizeOwner(h, "GET", config)).toBe("forbidden");
    expect(authorizeOwner(headers(identity([{ typ: "iss", val: "https://other.invalid" }])), "GET", config)).toBe("forbidden");
  });
  it("checks before the business handler, removes exception details and sets no-store", async () => {
    env(); const handler = vi.fn(async (request: Request) => { void request; throw Error("FICTIONAL_SECRET_SENTINEL"); });
    const route = withOwnerRoute(handler);
    expect((await route(new Request(config.origin))).status).toBe(401); expect(handler).not.toHaveBeenCalled();
    const response = await route(new Request(config.origin, { headers: headers() }));
    expect(handler).toHaveBeenCalledTimes(1); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("FICTIONAL_SECRET_SENTINEL");
    expect(response.headers.get("cache-control")).toBe(OWNER_CACHE_CONTROL);
  });
});
