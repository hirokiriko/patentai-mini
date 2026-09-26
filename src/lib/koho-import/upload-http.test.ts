import { afterEach, describe, expect, it, vi } from "vitest";
import { withOwnerRoute } from "../owner-http";
import { kohoUploadHandlers, readUploadBody } from "./upload-http";
import { uploadFixture } from "./upload.test-support";
import { KOHO_UPLOAD_CHUNK_BYTES } from "./upload-contract";

afterEach(() => vi.unstubAllEnvs());
function ownerHeaders() {
  vi.stubEnv("OWNER_AUTH_MODE", "azure-easy-auth"); vi.stubEnv("OWNER_APP_ORIGIN", "https://fictional.invalid");
  vi.stubEnv("OWNER_TENANT_ID", "11111111-1111-1111-1111-111111111111");
  vi.stubEnv("OWNER_OBJECT_ID", "22222222-2222-2222-2222-222222222222");
  vi.stubEnv("OWNER_CLIENT_ID", "33333333-3333-3333-3333-333333333333");
  return { origin: "https://fictional.invalid", "content-type": "application/json", "x-ms-client-principal":
    Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [{ typ: "oid", val: process.env.OWNER_OBJECT_ID }, { typ: "tid", val: process.env.OWNER_TENANT_ID }] })).toString("base64") };
}
describe("OWNER upload HTTP boundary", () => {
  it.each(["anonymous", "origin", "other-owner"])("rejects %s before reading the upload or constructing storage", async mode => {
    const headers: Record<string, string> = ownerHeaders();
    if (mode === "anonymous") delete headers["x-ms-client-principal"];
    if (mode === "origin") headers.origin = "https://other.invalid";
    if (mode === "other-owner") headers["x-ms-client-principal"] = Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [] })).toString("base64");
    const configure = vi.fn(), body = new ReadableStream({ pull() { throw Error("MUST_NOT_READ"); } });
    const r = new Request("https://fictional.invalid/api/admin/koho-uploads", { method: "POST", headers, body, duplex: "half" } as RequestInit);
    const response = await withOwnerRoute(kohoUploadHandlers(configure).create)(r);
    expect([401, 403]).toContain(response.status); expect(configure).not.toHaveBeenCalled(); expect(r.bodyUsed).toBe(false);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects an over-limit actual body without relying on a Content-Length header", async () => {
    const configure = vi.fn(), r = new Request("https://fictional.invalid", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(KOHO_UPLOAD_CHUNK_BYTES + 1) });
    const response = await kohoUploadHandlers(configure).chunk(r, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "0");
    expect(response.status).toBe(400); expect(configure).not.toHaveBeenCalled();
  });
  it("cancels a stalled body at the shared deadline", async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const r = new Request("https://fictional.invalid", { method: "PUT", body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
    const reading = readUploadBody(r, 1024, controller.signal); controller.abort();
    await expect(reading).rejects.toThrow(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects caller-selected storage/settings and keeps exception details out of the response", async () => {
    const f = uploadFixture(), configure = vi.fn(async () => f.store), h = kohoUploadHandlers(configure);
    const r = (v: unknown) => new Request("https://fictional.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
    expect((await h.create(r({ ...f.input, settings: f.settings }))).status).toBe(400); expect(configure).not.toHaveBeenCalled();
    configure.mockRejectedValue(Error("FICTIONAL_CONNECTION_STRING_SECRET"));
    const response = await h.create(r(f.input)); expect(response.status).toBe(503); expect(await response.text()).not.toContain("SECRET");
  });
  it("returns only the safe DTO and refuses paths/actions supplied through HTTP", async () => {
    const f = uploadFixture(), configure = vi.fn(async () => f.store), h = kohoUploadHandlers(configure);
    const r = new Request("https://fictional.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.input) });
    const response = await h.create(r); expect(response.status).toBe(200);
    const v = await response.json(); expect(v).toMatchObject({ operationId: f.input.operationId, status: "uploading", sourceAcquiredAt: null });
    expect(JSON.stringify(v)).not.toMatch(/codeSha|budgetBinding|secretRef|sourceSha/);
    const before = configure.mock.calls.length;
    expect((await h.status(new Request("https://fictional.invalid"), "../source.zip")).status).toBe(400);
    expect(configure.mock.calls).toHaveLength(before);
  });
});
