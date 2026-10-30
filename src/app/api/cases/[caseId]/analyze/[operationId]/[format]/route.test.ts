import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fictionalSaved } from "../../../../../../../lib/prior-art-comparison/fixtures.test-support";
const seam = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/prior-art-comparison/repository", () => ({ getComparison: seam.read }));
vi.mock("@/lib/owner-http", () => import("../../../../../../../lib/owner-http"));
vi.mock("@/lib/prior-art-comparison/http", () => import("../../../../../../../lib/prior-art-comparison/http"));
vi.mock("@/lib/prior-art-comparison/source", () => import("../../../../../../../lib/prior-art-comparison/source"));
vi.mock("@/lib/prior-art-comparison/report", () => import("../../../../../../../lib/prior-art-comparison/report"));
vi.mock("@/lib/patent-watch/period-report-pdf", () => import("../../../../../../../lib/patent-watch/period-report-pdf"));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
import { GET } from "./route";
const owner = "11111111-1111-1111-1111-111111111111", tenant = "22222222-2222-2222-2222-222222222222";
const saved = fictionalSaved();
const context = (format: string) => ({ params: Promise.resolve({ caseId: String(saved.inputs.caseId), operationId: saved.operationId, format }) });
function request(oid?: string) {
  return new Request("https://fictional.invalid/api/cases/7/analyze/result", { headers: oid ? { "x-ms-client-principal": Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [{ typ: "oid", val: oid }, { typ: "tid", val: tenant }] })).toString("base64") } : undefined });
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ PRIOR_ART_COMPARISON_ENABLED: "0", OWNER_AUTH_MODE: "azure-easy-auth", OWNER_APP_ORIGIN: "https://fictional.invalid", OWNER_OBJECT_ID: owner, OWNER_TENANT_ID: tenant, OWNER_CLIENT_ID: "33333333-3333-3333-3333-333333333333" })) vi.stubEnv(key, value);
  seam.read.mockResolvedValue({ saved, stale: false });
});
afterEach(() => vi.unstubAllEnvs());
it.each(["pdf", "csv"])("denies anonymous and non-OWNER %s before reading saved data", async format => {
  expect((await GET(request(), context(format))).status).toBe(401);
  expect((await GET(request(tenant), context(format))).status).toBe(403);
  expect(seam.read).not.toHaveBeenCalled();
});
it.each(["pdf", "csv"])("keeps authenticated saved %s downloads available while new comparisons are OFF", async format => {
  const response = await GET(request(owner), context(format));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(seam.read).toHaveBeenCalledExactlyOnceWith(saved.inputs.caseId, saved.operationId);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (format === "pdf") expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  else { expect(bytes.toString()).toContain("OWNER限定の試験版"); expect(bytes.toString()).toContain(saved.operationId); }
});
