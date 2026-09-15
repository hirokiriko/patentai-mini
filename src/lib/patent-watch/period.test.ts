import { describe, expect, it } from "vitest";
import { comparePatentWatchTimestamps } from "./domain";
import { parsePeriodQuery, periodBounds, periodCaseId, periodDateTimeLabel, previousWatchPeriod } from "./period";

describe("watch period calendar and exact query", () => {
  it.each([
    ["2096-03-31T15:00:00Z", "week", "2096-03-19", "2096-03-25"],
    ["2026-09-14T00:00:00Z", "week", "2026-09-07", "2026-09-13"],
    ["2026-09-13T14:59:59Z", "week", "2026-08-31", "2026-09-06"],
    ["2026-09-13T15:00:00Z", "week", "2026-09-07", "2026-09-13"],
    ["2026-01-01T00:00:00Z", "week", "2025-12-22", "2025-12-28"],
    ["2096-02-29T15:00:00Z", "month", "2096-02-01", "2096-02-29"],
    ["2100-03-01T00:00:00Z", "month", "2100-02-01", "2100-02-28"],
    ["2026-01-01T00:00:00Z", "month", "2025-12-01", "2025-12-31"],
  ] as const)("derives JST %s %s", (now, preset, from, to) => {
    expect(previousWatchPeriod(preset, new Date(now))).toEqual({ from, to });
  });
  it("accepts one day, leap day and 31 days, rejects 32 days", () => {
    for (const [from, to] of [["2096-02-29", "2096-02-29"], ["2026-01-01", "2026-01-31"], ["2025-12-31", "2026-01-30"]]) expect(parsePeriodQuery({ from, to }).kind).toBe("valid");
    expect(parsePeriodQuery({ from: "2026-01-01", to: "2026-02-01" }).kind).toBe("invalid");
  });
  it.each([
    { from: "2026-02-29", to: "2026-03-01" }, { from: "2026-03-02", to: "2026-03-01" },
    { from: "2026-3-01", to: "2026-03-01" }, { from: "2026-03-01 " , to: "2026-03-01" },
    { from: "2026-04-31", to: "2026-04-31" }, { from: "0000-01-01", to: "0000-01-01" },
    { from: ["2026-03-01", "2026-03-01"], to: "2026-03-01" }, { from: "2026-03-01", to: ["2026-03-01"] },
    { from: "2026-03-01" }, { to: "2026-03-01" }, { from: "2026-03-01", to: "2026-03-01", extra: "secret" },
    { from: "", to: "" }, { from: "2026-03-01T00:00:00Z", to: "2026-03-01" },
  ])("rejects malformed query without reflecting input", query => expect(parsePeriodQuery(query)).toEqual({ kind: "invalid" }));
  it("does not require a query to select a period", () => expect(parsePeriodQuery({})).toEqual({ kind: "select" }));
  it("preserves both JST boundaries at microsecond resolution", () => {
    const bounds = periodBounds({ from: "2026-03-01", to: "2026-03-01" });
    expect(bounds).toEqual({ fromInclusive: "2026-02-28T15:00:00.000Z", toExclusive: "2026-03-01T15:00:00.000Z" });
    const inside = (t: string) => comparePatentWatchTimestamps(t, bounds.fromInclusive) >= 0 && comparePatentWatchTimestamps(t, bounds.toExclusive) < 0;
    expect(["2026-02-28T14:59:59.999999Z", "2026-02-28T15:00:00.000000Z", "2026-02-28T15:00:00.000001Z", "2026-03-01T14:59:59.999999Z", "2026-03-01T15:00:00.000000Z", "2026-03-01T15:00:00.000001Z"].map(inside)).toEqual([false, true, true, true, false, false]);
    expect(periodDateTimeLabel("2026-02-28T15:00:00Z")).toContain("2026/03/01");
    expect(periodDateTimeLabel("2026-03-01T00:00:00+09")).toBe(periodDateTimeLabel("2026-03-01 00:00:00.000001+09"));
  });
  it.each(["0", "-1", "01", "7x", "2147483648", "<script>"])("rejects invalid case %s", input => expect(periodCaseId(input)).toBeNull());
});
