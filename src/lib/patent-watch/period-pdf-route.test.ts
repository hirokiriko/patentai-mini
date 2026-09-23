// Existing domain/renderer tests isolate authentication; owner-auth tests cover the real boundary.
vi.mock("@/lib/owner-http", () => ({ withOwnerRoute: (handler: unknown) => handler, requireOwner: async () => undefined }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixturePeriod, periodFixture, SECRET_SENTINEL } from "./period-fixtures.test-support";
import { PERIOD_PDF_LIMITS } from "./period-report-pdf";
import { PERIOD_READ_TIMEOUT_MS } from "./period";
const seam = vi.hoisted(() => ({ readPeriodSnapshot: vi.fn() }));
vi.mock("@/repositories", () => ({ patentWatchRepo: seam }));
vi.mock("@/lib/patent-watch/period", () => import("./period"));
vi.mock("@/lib/patent-watch/period-report", () => import("./period-report"));
vi.mock("@/lib/patent-watch/period-report-pdf", () => import("./period-report-pdf"));
import { GET } from "../../app/api/cases/[caseId]/watch/period-report.pdf/route";
const valid = new URLSearchParams(fixturePeriod).toString();
const get = (query = valid, caseId = "7") => GET(new Request(`http://localhost/api/cases/${caseId}/watch/period-report.pdf?${query}`), { params: Promise.resolve({ caseId }) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); seam.readPeriodSnapshot.mockReset(); });
describe("real period PDF GET handler", () => {
  it("returns complete PDF bytes with private attachment headers", async () => {
    seam.readPeriodSnapshot.mockResolvedValue(periodFixture());
    const response = await get();
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="period-report-7-2096-03-01-2096-03-31.pdf"');
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(seam.readPeriodSnapshot).toHaveBeenCalledExactlyOnceWith(7, fixturePeriod);
  });
  it.each(["", "from=2096-03-01", `${valid}&from=2096-03-01`, `${valid}&to=2096-03-31`, `${valid}&extra=x`, "from=2096-02-30&to=2096-03-01", "from=2096-03-02&to=2096-03-01", "from=2096-03-01&to=2096-04-01", "__proto__=x"])("rejects query before repository access: %s", async query => {
    expect((await get(query)).status).toBe(400); expect(seam.readPeriodSnapshot).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "01", "abc", "2147483648"])("rejects invalid case %s", async id => {
    expect((await get(valid, id)).status).toBe(400); expect(seam.readPeriodSnapshot).not.toHaveBeenCalled();
  });
  it.each(["absent", "foreign-case", "foreign-watch", "foreign-run", "unavailable", "limit", "glyph"])("fails closed: %s", async kind => {
    const snapshot = periodFixture();
    if (kind === "foreign-case") snapshot.caseId++;
    if (kind === "foreign-watch") snapshot.findings[0].watchId++;
    if (kind === "foreign-run") snapshot.findings[0].firstRunId = 999;
    if (kind === "glyph") snapshot.findings[0].inventionTitle = "\u{10FFFF}";
    if (kind === "limit") snapshot.runs = periodFixture(201, 0).runs;
    if (kind === "unavailable") seam.readPeriodSnapshot.mockRejectedValue(Error(SECRET_SENTINEL));
    else seam.readPeriodSnapshot.mockResolvedValue(kind === "absent" ? null : snapshot);
    const response = await get();
    expect(response.status).toBe(kind === "absent" ? 404 : kind === "limit" ? 413 : kind === "glyph" ? 422 : 503);
    expect(response.headers.get("content-type")).not.toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain(SECRET_SENTINEL);
  });
  it("does not return a partial PDF on output exhaustion", async () => {
    seam.readPeriodSnapshot.mockResolvedValue(periodFixture());
    const bytes = PERIOD_PDF_LIMITS.bytes;
    try { Object.assign(PERIOD_PDF_LIMITS, { bytes: 20 }); expect((await get()).status).toBe(413); }
    finally { Object.assign(PERIOD_PDF_LIMITS, { bytes }); }
  });
  it("keeps the existing read deadline", async () => {
    vi.useFakeTimers(); seam.readPeriodSnapshot.mockReturnValue(new Promise(() => {}));
    const pending = get(); await vi.advanceTimersByTimeAsync(PERIOD_READ_TIMEOUT_MS);
    expect((await pending).status).toBe(503);
  });
  it("returns a fixed 503 if the packaged font cannot be read", async () => {
    seam.readPeriodSnapshot.mockResolvedValue(periodFixture());
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/__fictional_missing_period_pdf_font__");
    const response = await get(); cwd.mockRestore();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("fictional_missing");
  });
});
