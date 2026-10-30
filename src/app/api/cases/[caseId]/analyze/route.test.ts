import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reserve: vi.fn(), complete: vi.fn(), after: vi.fn(), list: vi.fn(), catalog: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/owner-http", () => import("../../../../../lib/owner-http"));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/prior-art-comparison/repository", () => ({ reserveComparison: mocks.reserve,
  completeReservedComparison: mocks.complete, listComparisons: mocks.list, comparisonCatalog: mocks.catalog }));
vi.mock("@/lib/prior-art-comparison/comparison", () => import("../../../../../lib/prior-art-comparison/comparison"));
vi.mock("@/lib/prior-art-comparison/source", () => import("../../../../../lib/prior-art-comparison/source"));
vi.mock("@/lib/prior-art-comparison/http", () => import("../../../../../lib/prior-art-comparison/http"));
vi.mock("@/lib/prior-art-comparison/availability", () => import("../../../../../lib/prior-art-comparison/availability"));
import { GET, POST } from "./route";
const selection = { operationId: "12345678-1234-4234-8234-123456789abc", inputDigest: "a".repeat(64),
  draftClaimNos: [1], draftIdentity: { publication: "fictional base", edition: "1" }, originalsConfirmed: true,
  documents: [1,2].map(docId => ({ docId, claimNos: [1], identity: { publication: `fictional ${docId}`, edition: "1" } })) };
const context = () => ({ params: Promise.resolve({ caseId: "1" }) });
const owner = "11111111-1111-1111-1111-111111111111", tenant = "22222222-2222-2222-2222-222222222222";
const ownerHeaders = (oid = owner) => ({ origin: "https://fictional.invalid", "x-ms-client-principal": Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [{ typ: "oid", val: oid }, { typ: "tid", val: tenant }] })).toString("base64") });
const request = () => new Request("https://fictional.invalid/api/cases/1/analyze", { method: "POST", headers: ownerHeaders(), body: JSON.stringify(selection) });
const getRequest = (query = "") => new Request(`https://fictional.invalid/api/cases/1/analyze${query}`, { headers: ownerHeaders() });
describe("durable comparison acceptance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const [key, value] of Object.entries({ PRIOR_ART_COMPARISON_ENABLED: "1", OWNER_AUTH_MODE: "azure-easy-auth", OWNER_APP_ORIGIN: "https://fictional.invalid", OWNER_OBJECT_ID: owner, OWNER_TENANT_ID: tenant, OWNER_CLIENT_ID: "33333333-3333-3333-3333-333333333333" })) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["0", "1"])("enforces OWNER and CSRF before comparison admission (switch %s)", async enabled => {
    vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", enabled);
    for (const method of ["GET", "POST"]) {
      const handler = method === "GET" ? GET : POST;
      const url = "https://fictional.invalid/api/cases/1/analyze";
      expect((await handler(new Request(url, { method }), context())).status).toBe(401);
      expect((await handler(new Request(url, { method, headers: ownerHeaders(tenant) }), context())).status).toBe(403);
    }
    for (const origin of ["", "https://other.invalid"]) {
      expect((await POST(new Request("https://fictional.invalid/api/cases/1/analyze", { method: "POST", headers: { ...ownerHeaders(), origin } }), context())).status).toBe(403);
    }
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "0", "false", "true", " 1", "1 "])("refuses new comparisons before reservation or scheduling when disabled (%s)", async value => {
    vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", value);
    const response = await POST(request(), context());
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("comparison_disabled");
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("waits for reservation ACK before scheduling and returns before AI completion", async () => {
    let ack!: (value: unknown) => void;
    mocks.reserve.mockReturnValue(new Promise(resolve => { ack = resolve; }));
    const response = POST(request(), context());
    await vi.waitFor(() => expect(mocks.reserve).toHaveBeenCalledOnce());
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
    const reservation = { inputs: {}, ids: [1,2] }; ack(reservation);
    expect((await response).status).toBe(202);
    expect(mocks.complete).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(1, selection, reservation);
  });
  it("never schedules again for an existing reservation", async () => {
    mocks.reserve.mockResolvedValue({ pending: true });
    expect((await POST(request(), context())).status).toBe(202);
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("returns an existing completed result with no dispatch", async () => {
    mocks.reserve.mockResolvedValue({ existing: { operationId: selection.operationId, generatedAt: "saved" } });
    const response = await POST(request(), context());
    expect(response.status).toBe(200); expect((await response.json()).status).toBe("complete");
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("does not dispatch when the commit ACK is unknown", async () => {
    mocks.reserve.mockRejectedValue(Error("uncertain commit"));
    await POST(request(), context());
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("a failed background callback is not retried", async () => {
    mocks.reserve.mockResolvedValue({ inputs: {}, ids: [1,2] }); mocks.complete.mockRejectedValue(Error("failed"));
    await POST(request(), context()); await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledOnce(); expect(mocks.after).toHaveBeenCalledOnce();
  });
  it("status reads only read persisted results, with zero dispatch", async () => {
    vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", "0");
    mocks.catalog.mockResolvedValue({ caseId: 1 }); mocks.list.mockResolvedValue({ results: [], failedOperations: [], pendingOperationIds: [selection.operationId] });
    const response = await GET(getRequest(), context());
    const result = await response.json();
    expect(result.enabled).toBe(false);
    expect(result.saved.pendingOperationIds).toEqual([selection.operationId]);
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each(["reserved", "complete", "unconfirmed"])("operation status %s is read without raw catalog or AI", async status => {
    vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", "0");
    mocks.list.mockResolvedValue({ results: status === "complete" ? [{ operationId: selection.operationId }] : [],
      failedOperations: [], pendingOperationIds: status === "reserved" ? [selection.operationId] : [] });
    const response = await GET(getRequest(`?operationId=${selection.operationId}`), context());
    expect(await response.json()).toEqual({ operationId: selection.operationId, status });
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("rejects malformed operation IDs before reading saved state", async () => {
    await GET(getRequest("?operationId=invalid"), context());
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("reports a known failure without retry or raw diagnostic output", async () => {
    const failure = { stage: "review", kind: "review_rejected" };
    mocks.list.mockResolvedValue({ results: [], pendingOperationIds: [selection.operationId], failedOperations: [{ operationId: selection.operationId, failure }] });
    const response = await GET(getRequest(`?operationId=${selection.operationId}`), context());
    expect(await response.json()).toEqual({ operationId: selection.operationId, status: "failed", failure });
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });

});
