import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPeriodReport, readPeriodReport, type PeriodSnapshot } from "./period-report";
import { PERIOD_READ_TIMEOUT_MS } from "./period";
import { fixturePeriod, periodFixture, RAW_SENTINEL, SECRET_SENTINEL } from "./period-fixtures.test-support";

const build = (snapshot: PeriodSnapshot) => buildPeriodReport(7, fixturePeriod, snapshot);
const read = (snapshot: PeriodSnapshot | null) => readPeriodReport({ readPeriodSnapshot: async () => snapshot }, 7, fixturePeriod);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("read-only period report validation", () => {
  it.each([[21, 101], [200, 4000], [2, 0], [0, 0]])("preserves all %i runs / %i distinct findings", (runs, findings) => {
    const model = build(periodFixture(runs, findings));
    expect(model.runs).toHaveLength(runs); expect(model.findings).toHaveLength(findings);
    expect(model.summary.reviewed + model.summary.unreviewed).toBe(findings);
    expect(model.summary.ai + model.summary.fallback).toBe(findings);
    // Same publication number is not an identity: updated-text findings survive.
    if (findings) expect(new Set(model.findings.map(f => f.publicationNumber)).size).toBe(1);
  });
  it.each([[201, 0], [1, 4001]])("rejects excess %i / %i without partial output", async (runs, findings) => {
    expect(await read(periodFixture(runs, findings))).toEqual({ kind: "too_many" });
  });
  it("shows successful findings while retaining failed/running runs", () => {
    const snapshot = periodFixture(3, 1);
    snapshot.runs[1].status = "failed";
    snapshot.runs[2].status = "running"; snapshot.runs[2].completedAt = null;
    expect(build(snapshot).summary).toMatchObject({ completed: 1, failed: 1, running: 1, ai: 1 });
  });
  it("keeps a run in its start period even when completed next month", () => {
    expect(build(periodFixture()).findings).toHaveLength(3);
  });
  it("re-run with zero new findings does not repeat an earlier detection", () => {
    const snapshot = periodFixture(2, 1);
    expect(build(snapshot).runs[1].newFindingCount).toBe(0);
    expect(build(snapshot).findings).toHaveLength(1);
  });
  it.each([
    (s: PeriodSnapshot) => { s.caseId = 8; },
    (s: PeriodSnapshot) => { s.runs[0].watchId = 12; },
    (s: PeriodSnapshot) => { s.findings[0].watchId = 12; },
    (s: PeriodSnapshot) => { s.findings[0].firstRunId = 999; },
    (s: PeriodSnapshot) => { s.runs[0].startedAt = "2096-02-28T14:59:59.999999Z"; },
    (s: PeriodSnapshot) => { s.runs[0].startedAt = "2096-03-31T15:00:00.000000Z"; },
    (s: PeriodSnapshot) => { s.findings[0].reviewStatus = "bad" as never; },
    (s: PeriodSnapshot) => { s.findings[0].analysisMode = "none" as never; },
    (s: PeriodSnapshot) => { s.findings[0].analysisJson = "null"; },
    (s: PeriodSnapshot) => { s.findings[0].semanticScore = NaN; },
    (s: PeriodSnapshot) => { s.runs[0].newFindingCount++; },
    (s: PeriodSnapshot) => { s.runs[0].fallbackFindingCount++; },
    (s: PeriodSnapshot) => { s.runs[0].completedAt = null; },
    (s: PeriodSnapshot) => { s.runs[0].status = "failed"; },
    (s: PeriodSnapshot) => { s.runs.push(s.runs[0]); },
    (s: PeriodSnapshot) => { s.findings.push(s.findings[0]); },
    (s: PeriodSnapshot) => { s.findings[0].firstSeenAt = "invalid"; },
  ])("rejects corrupted, foreign or inconsistent data", async mutate => {
    const snapshot = periodFixture(); mutate(snapshot);
    expect(await read(snapshot)).toEqual({ kind: "unavailable" });
  });
  it("strips raw fields, secrets, paths and hashes from the released model", () => {
    const snapshot = periodFixture();
    Object.assign(snapshot, { title: RAW_SENTINEL, claims: RAW_SENTINEL });
    Object.assign(snapshot.findings[0], { sourceKey: RAW_SENTINEL, claimsText: RAW_SENTINEL, rawXml: RAW_SENTINEL, contentSha256: RAW_SENTINEL });
    snapshot.findings[0].inventionTitle = `secret=${SECRET_SENTINEL}`;
    snapshot.findings[0].publicationNumber = "a".repeat(64);
    const before = structuredClone(snapshot);
    const output = JSON.stringify(build(snapshot));
    expect(output).not.toContain(SECRET_SENTINEL); expect(output).not.toContain(RAW_SENTINEL); expect(output).not.toContain("a".repeat(64));
    expect(snapshot).toEqual(before);
  });
  it("enforces existing text/list limits and retains Unknown", () => {
    const snapshot = periodFixture(1, 1);
    snapshot.findings[0].inventionTitle = "名".repeat(600);
    snapshot.findings[0].analysisJson = JSON.stringify({ matchedElements: Array(60).fill("文".repeat(600)), unmatchedElements: [], explanation: "説".repeat(3000) });
    const finding = build(snapshot).findings[0];
    expect(finding.inventionTitle.length).toBe(500); expect(finding.matchedElements.length).toBe(50); expect(finding.matchedElements[0].length).toBe(500); expect(finding.explanation.length).toBe(2000); expect(finding.riskLabel).toBe("Unknown");
  });
  it("bounds a stalled read and never logs errors or invokes mutations/AI", async () => {
    vi.useFakeTimers(); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mutation = vi.fn(); const repository = { readPeriodSnapshot: vi.fn(() => new Promise<PeriodSnapshot>(() => {})), startRun: mutation, import: mutation, ai: mutation, updateFindingReviewStatus: mutation };
    const pending = readPeriodReport(repository, 7, fixturePeriod);
    await vi.advanceTimersByTimeAsync(PERIOD_READ_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "unavailable" });
    repository.readPeriodSnapshot.mockRejectedValueOnce(new Error(SECRET_SENTINEL));
    expect(await readPeriodReport(repository, 7, fixturePeriod)).toEqual({ kind: "unavailable" });
    expect(mutation).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it("distinguishes nonexistent cases", async () => expect(await read(null)).toEqual({ kind: "not_found" }));
});
