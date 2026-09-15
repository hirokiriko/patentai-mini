import { z } from "zod";
import { boundedPatentWatchPublicText, comparePatentWatchTimestamps, isValidPatentWatchDate, isValidPatentWatchTimestamp, sanitizePatentWatchAnalysis } from "./domain";
import { PERIOD_FINDING_LIMIT, PERIOD_READ_TIMEOUT_MS, PERIOD_RUN_LIMIT, PeriodReportLimitError, periodBounds, periodCaseId, type WatchPeriod } from "./period";

const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative().max(2_147_483_647);
const timestamp = z.string().refine(isValidPatentWatchTimestamp);
const runSchema = z.object({
  runId: id, watchId: id, status: z.enum(["completed", "failed", "running"]),
  startedAt: timestamp, completedAt: timestamp.nullable(),
  newFindingCount: count, fallbackFindingCount: count,
});
const score = z.number().min(0).max(1);
const findingSchema = z.object({
  findingId: id, watchId: id, firstRunId: id, firstSeenAt: timestamp,
  publicationNumber: z.string().min(1), publicationDate: z.string().refine(isValidPatentWatchDate), inventionTitle: z.string(),
  lexicalScore: score, elementScore: score, semanticScore: score, structuralScore: score,
  riskLabel: z.enum(["High", "Medium", "Low", "Unknown"]),
  analysisMode: z.enum(["ai", "fallback"]), reviewStatus: z.enum(["reviewed", "unreviewed"]), analysisJson: z.string(),
});
const analysisSchema = z.object({ matchedElements: z.array(z.string()), unmatchedElements: z.array(z.string()), explanation: z.string() });
export type PeriodRunRow = z.infer<typeof runSchema>;
export type PeriodFindingRow = z.infer<typeof findingSchema>;
export type PeriodSnapshot = {
  caseId: number; watchId: number | null; createdAt: string;
  runs: PeriodRunRow[]; findings: PeriodFindingRow[];
};
export type PeriodReportRepository = {
  readPeriodSnapshot(caseId: number, period: WatchPeriod): Promise<PeriodSnapshot | null>;
};
export type PeriodFindingView = Omit<PeriodFindingRow, "watchId" | "analysisJson"> & z.infer<typeof analysisSchema>;
export type PeriodReportModel = {
  caseId: number; period: WatchPeriod; createdAt: string;
  runs: Array<Omit<PeriodRunRow, "watchId">>; findings: PeriodFindingView[];
  summary: { completed: number; failed: number; running: number; reviewed: number; unreviewed: number; ai: number; fallback: number };
};
export type PeriodReportResult =
  | { kind: "ready"; report: PeriodReportModel }
  | { kind: "not_found" | "unavailable" | "too_many" };

/** Validate the whole snapshot before releasing any display rows. */
export function buildPeriodReport(caseId: number, period: WatchPeriod, input: PeriodSnapshot): PeriodReportModel {
  const bounds = periodBounds(period);
  if (input.runs.length > PERIOD_RUN_LIMIT || input.findings.length > PERIOD_FINDING_LIMIT) throw new PeriodReportLimitError();
  const snapshot = z.object({ caseId: id, watchId: id.nullable(), createdAt: timestamp, runs: z.array(runSchema), findings: z.array(findingSchema) }).parse(input);
  const invalid = () => { throw new Error("invalid period snapshot"); };
  if (snapshot.caseId !== caseId) invalid();
  const runs = new Map<number, PeriodRunRow>();
  for (const run of snapshot.runs) {
    if (run.watchId !== snapshot.watchId || runs.has(run.runId) || comparePatentWatchTimestamps(run.startedAt, bounds.fromInclusive) < 0 || comparePatentWatchTimestamps(run.startedAt, bounds.toExclusive) >= 0) invalid();
    if ((run.status === "running") !== (run.completedAt === null) || (run.completedAt !== null && comparePatentWatchTimestamps(run.completedAt, run.startedAt) < 0)) invalid();
    runs.set(run.runId, run);
  }
  const seen = new Set<number>();
  const counts = new Map<number, { total: number; fallback: number }>();
  const findings = snapshot.findings.map((finding): PeriodFindingView => {
    const run = runs.get(finding.firstRunId);
    if (!run || run.status !== "completed" || finding.watchId !== snapshot.watchId || seen.has(finding.findingId) || comparePatentWatchTimestamps(finding.firstSeenAt, run.startedAt) < 0) invalid();
    seen.add(finding.findingId);
    const runCounts = counts.get(finding.firstRunId) ?? { total: 0, fallback: 0 };
    runCounts.total++; if (finding.analysisMode === "fallback") runCounts.fallback++;
    counts.set(finding.firstRunId, runCounts);
    const analysis = sanitizePatentWatchAnalysis(analysisSchema.parse(JSON.parse(finding.analysisJson)));
    return {
      findingId: finding.findingId, firstRunId: finding.firstRunId, firstSeenAt: finding.firstSeenAt,
      publicationNumber: boundedPatentWatchPublicText(finding.publicationNumber, 100),
      publicationDate: finding.publicationDate, inventionTitle: boundedPatentWatchPublicText(finding.inventionTitle, 500),
      lexicalScore: finding.lexicalScore, elementScore: finding.elementScore, semanticScore: finding.semanticScore, structuralScore: finding.structuralScore,
      riskLabel: finding.riskLabel, analysisMode: finding.analysisMode, reviewStatus: finding.reviewStatus, ...analysis,
    };
  });
  for (const run of runs.values()) {
    if (run.status === "completed" && (run.newFindingCount !== (counts.get(run.runId)?.total ?? 0) || run.fallbackFindingCount !== (counts.get(run.runId)?.fallback ?? 0))) invalid();
  }
  const summary = {
    completed: snapshot.runs.filter(run => run.status === "completed").length,
    failed: snapshot.runs.filter(run => run.status === "failed").length,
    running: snapshot.runs.filter(run => run.status === "running").length,
    reviewed: findings.filter(finding => finding.reviewStatus === "reviewed").length,
    unreviewed: findings.filter(finding => finding.reviewStatus === "unreviewed").length,
    ai: findings.filter(finding => finding.analysisMode === "ai").length,
    fallback: findings.filter(finding => finding.analysisMode === "fallback").length,
  };
  return { caseId, period, createdAt: snapshot.createdAt, summary, findings,
    runs: snapshot.runs.map(run => ({ runId: run.runId, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, newFindingCount: run.newFindingCount, fallbackFindingCount: run.fallbackFindingCount })),
  };
}
export async function readPeriodReport(repository: PeriodReportRepository, caseId: number, period: WatchPeriod): Promise<PeriodReportResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (periodCaseId(String(caseId)) === null) return { kind: "not_found" };
    periodBounds(period);
    const snapshot = await Promise.race([
      repository.readPeriodSnapshot(caseId, period),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("period timeout")), PERIOD_READ_TIMEOUT_MS); }),
    ]);
    if (!snapshot) return { kind: "not_found" };
    return { kind: "ready", report: buildPeriodReport(caseId, period, snapshot) };
  } catch (error) {
    return { kind: error instanceof PeriodReportLimitError ? "too_many" : "unavailable" };
  } finally { clearTimeout(timer); }
}
