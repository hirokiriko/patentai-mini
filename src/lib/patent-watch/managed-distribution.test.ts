import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISTRIBUTION_HEADERS } from "../koho-distribution-table";
import { acquireManagedDistribution, managedDistributionRows, MANAGED_DISTRIBUTION_URL, validateManagedCoverage } from "./managed-distribution";
const row = (date: string, issue: string, cumulative: string) => [date, issue, cumulative, "000001", "000002", "", "", "00002", "00000", "可", ""].join(",");
const csvText = [DISTRIBUTION_HEADERS.JPA.join(","), row("20260724", "136", "01103"), row("20260812", "148", "01115"), row("20260813", "149", "01116"), row("20260826", "158", "01125")].join("\r\n") + "\r\n";
const snapshot = () => ({ csvText, sha256: createHash("sha256").update(csvText).digest("hex"), sourceUrl: MANAGED_DISTRIBUTION_URL, acquiredAt: "2026-09-22T00:00:00.000Z" });
const period = { from: "2026-07-26", to: "2026-08-25" };
afterEach(() => vi.restoreAllMocks());
describe("official distribution evidence", () => {
  it("derives all period rows from the exact observed CSV, never a caller package subset", () => {
    expect(managedDistributionRows(snapshot(), period).map(r => r.issueNumber)).toEqual(["2026-148", "2026-149"]);
    expect(() => validateManagedCoverage({ distributionTableSha256: snapshot().sha256, packages: [] })).toThrow();
    expect(() => managedDistributionRows({ ...snapshot(), csvText: csvText.replace(row("20260813", "149", "01116") + "\r\n", "") }, period)).toThrow("incomplete");
  });
  it("rejects a period beyond observed dates or a snapshot acquired before closing", () => {
    expect(() => managedDistributionRows(snapshot(), { ...period, to: "2026-09-25" })).toThrow("incomplete");
    expect(() => managedDistributionRows({ ...snapshot(), acquiredAt: "2026-08-20T00:00:00.000Z" }, period)).toThrow("incomplete");
    expect(() => managedDistributionRows({ ...snapshot(), sourceUrl: "https://example.invalid" }, period)).toThrow("incomplete");
  });
  it("permits a genuine zero-issue first period between verified surrounding publication dates", () => {
    expect(managedDistributionRows(snapshot(), {from:"2026-07-25",to:"2026-07-25"})).toEqual([]);
  });
  it("fetches only the fixed official endpoint with a deadline and no redirects", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(csvText));
    const result = await acquireManagedDistribution(); expect(result.sha256).toBe(snapshot().sha256);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe(MANAGED_DISTRIBUTION_URL);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
  });
  it("rejects an oversized response rather than storing a partial official listing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(1024**2+1)));
    await expect(acquireManagedDistribution()).rejects.toThrow("limit");
  });
});
