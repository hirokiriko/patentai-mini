import { describe, expect, it } from "vitest";
import { firstManagedPeriod, nextManagedPeriod, managedPeriodForPublication, managedDeliveryDueOn,
  managedJstDate, managedDeletionEligibleOn, previousBusinessDay, JAPAN_HOLIDAYS, validateManagedPeriod } from "./managed-period";

describe("managed publication periods", () => {
  it.each([
    ["2026-09-01", "2026-09-25"], ["2026-09-25", "2026-09-25"],
    ["2026-09-26", "2026-10-25"], ["2026-12-31", "2027-01-25"],
    ["2024-02-29", "2024-03-25"], ["2026-01-31", "2026-02-25"],
  ])("starts %s and first closes %s", (from, to) => {
    expect(firstManagedPeriod(from)).toEqual({ from, to });
    expect(nextManagedPeriod({ from, to }).from).toBe(to.slice(0, 8) + "26");
  });
  it("has no gaps for a leap year, February and year transitions", () => {
    let period = firstManagedPeriod("2023-12-26");
    const published = ["2024-01-25", "2024-01-26", "2024-02-29", "2024-12-31"];
    const coverage: string[] = [];
    for (let n = 0; n < 14; n++) {
      for (const day of published) if (day >= period.from && day <= period.to) coverage.push(day);
      period = nextManagedPeriod(period);
    }
    expect(coverage.sort()).toEqual(published);
  });
  it("assigns a delayed finding by original publication date regardless of comparison time", () => {
    expect(managedPeriodForPublication("2026-07-10", "2026-07-21")).toEqual({ from: "2026-07-10", to: "2026-07-25" });
    expect(managedPeriodForPublication("2026-07-10", "2026-08-26")).toEqual({ from: "2026-08-26", to: "2026-09-25" });
    expect(managedPeriodForPublication("2026-07-10", "2026-07-09")).toBeNull();
  });
  it("does not shift a Sunday publication cutoff or mix a future period", () => {
    expect(firstManagedPeriod("2026-10-01").to).toBe("2026-10-25");
    expect(managedPeriodForPublication("2026-09-26", "2026-10-26")?.from).toBe("2026-10-26");
  });
  it("separates JST midnight from UTC execution date", () => {
    expect(managedJstDate(new Date("2026-09-25T14:59:59.999Z"))).toBe("2026-09-25");
    expect(managedJstDate(new Date("2026-09-25T15:00:00.000Z"))).toBe("2026-09-26");
  });
  it("moves delivery to the preceding business day using verified holidays", () => {
    expect(managedDeliveryDueOn({ from: "2026-01-26", to: "2026-02-25" }, JAPAN_HOLIDAYS)).toBe("2026-02-27");
    expect(managedDeliveryDueOn({ from: "2026-04-26", to: "2026-05-25" }, JAPAN_HOLIDAYS)).toBe("2026-05-29");
    expect(previousBusinessDay("2026-09-23", JAPAN_HOLIDAYS)).toBe("2026-09-18");
    expect(previousBusinessDay("2027-03-22", JAPAN_HOLIDAYS)).toBe("2027-03-19");
  });
  it("does not treat an unknown calendar year as weekdays only", () => {
    expect(() => managedDeliveryDueOn({ from: "2027-12-26", to: "2028-01-25" }, JAPAN_HOLIDAYS)).toThrow("calendar_unconfirmed");
  });
  it("retains data for the complete 90 days after the contract end", () => {
    expect(managedDeletionEligibleOn("2026-09-23")).toBe("2026-12-23");
    expect(managedDeletionEligibleOn("2024-02-29")).toBe("2024-05-30");
  });
  it.each(["2026-02-29", "2026-13-01", "2026-1-01", "0000-01-01", "2026-01-01T00:00:00Z"])("rejects invalid date %s", value => {
    expect(() => firstManagedPeriod(value)).toThrow();
  });
  it("rejects arbitrary dates pretending to be a standard period", () => {
    expect(() => validateManagedPeriod({ from: "2026-07-01", to: "2026-08-25" })).toThrow("invalid_period");
  });
});
