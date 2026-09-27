import { afterEach, describe, expect, it, vi } from "vitest";
import { managedCloudFixture } from "./managed-cloud.test-support";
import { parseManagedCloudConfiguration } from "./managed-cloud-config";
import { managedBudgetedWatchFixture } from "./managed-execution-budget.test-support";
import { managedCloudImportFixture } from "../../../scripts/managed-koho-cloud.test-support";
import { parseCloudManifest } from "../koho-import/cloud-config";

afterEach(() => vi.useRealTimers());
describe("September release compatibility forecast boundaries", () => {
  it.each(["standard", "profile", "october", "absolute-cap"])("rejects a watch forecast outside the release allowance: %s", reason => {
    vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date(reason === "october" ? "2026-10-01T00:00:00Z" : "2026-09-28T00:00:00Z"));
    const config = managedBudgetedWatchFixture().config;
    config.budgetProof.monthlyForecastYen = reason === "absolute-cap" ? 50_001 : 31_000;
    if (reason === "standard") config.approval = "STANDARD_MANAGED_WATCH_STANDARD_V1";
    if (reason === "profile") config.serviceBudget.profileDigest = "f".repeat(64);
    expect(() => parseManagedCloudConfiguration(config)).toThrow();
  });
  it("retains ordinary forecasts outside September and accepts only the release preparation shape within September", () => {
    vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect(parseManagedCloudConfiguration(managedCloudFixture()).budgetProof.monthlyForecastYen).toBe(15_000);
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    const config = managedCloudFixture(); config.budgetProof.monthlyForecastYen = 31_000;
    expect(parseManagedCloudConfiguration(config).serviceBudget).toBeUndefined();
  });
  it.each(["2026-09-30T15:00:00.000Z", "2026-09-30T15:00:00.001Z"])("checks the import expiry against the inclusive September execution interval: %s", async expiry => {
    vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const fixture = await managedCloudImportFixture();
    fixture.manifest.expiresAt = expiry;
    fixture.manifest.releaseReservation.monthlyForecastYen = 31_000;
    await fixture.publish();
    const read = () => parseCloudManifest(Buffer.from(JSON.stringify(fixture.manifest)), fixture.config);
    if (expiry.endsWith(".000Z")) expect(read().expiresAt).toBe(expiry);
    else expect(read).toThrow();
  });
  it.each(["profile", "absolute-cap"])("rejects an import forecast outside the release allowance: %s", async reason => {
    vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date("2026-09-28T00:00:00Z"));
    const fixture = await managedCloudImportFixture();
    fixture.manifest.releaseReservation.monthlyForecastYen = reason === "absolute-cap" ? 50_001 : 31_000;
    if (reason === "profile") fixture.config.serviceBudget!.profileDigest = "f".repeat(64);
    await fixture.publish();
    expect(() => parseCloudManifest(Buffer.from(JSON.stringify(fixture.manifest)), fixture.config)).toThrow();
  });
});
