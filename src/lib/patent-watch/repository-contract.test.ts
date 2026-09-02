import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import type { PatentWatchRepository } from "../../repositories";

const SCHEMA_URL = new URL("../../db/schema.ts", import.meta.url);
const REPOSITORY_URL = new URL("../../repositories/drizzle.ts", import.meta.url);

async function source(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

function methodBlock(
  repositorySource: string,
  method: keyof PatentWatchRepository,
  nextMethod?: keyof PatentWatchRepository,
): string {
  const start = repositorySource.indexOf(`async ${String(method)}`);
  const end = nextMethod
    ? repositorySource.indexOf(`async ${String(nextMethod)}`, start)
    : repositorySource.length;

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return repositorySource.slice(start, end);
}

describe("PatentWatchRepository public contract", () => {
  it("keeps the additive repository responsibilities explicit", () => {
    const methods: Array<keyof PatentWatchRepository> = [
      "getSetting",
      "upsertSetting",
      "startRun",
      "findDocumentsForRun",
      "findExistingSourceKeys",
      "finalizeRunSuccess",
      "finalizeRunFailure",
      "getRun",
      "listRuns",
      "listFindings",
      "countUnreviewedFindings",
      "updateFindingReviewStatus",
    ];

    expect(methods).toEqual([
      "getSetting",
      "upsertSetting",
      "startRun",
      "findDocumentsForRun",
      "findExistingSourceKeys",
      "finalizeRunSuccess",
      "finalizeRunFailure",
      "getRun",
      "listRuns",
      "listFindings",
      "countUnreviewedFindings",
      "updateFindingReviewStatus",
    ]);
  });

  it("declares the three watch tables with cascade and identity constraints", async () => {
    const schema = await source(SCHEMA_URL);
    const watchSchema = schema.slice(
      schema.indexOf("export const caseWatchSettings"),
    );
    const watchRunSchema = schema.slice(
      schema.indexOf("export const caseWatchRuns"),
      schema.indexOf("export const caseWatchFindings"),
    );

    expect(watchSchema).toMatch(/pgTable\(\s*"case_watch_settings"/u);
    expect(watchSchema).toMatch(/pgTable\(\s*"case_watch_runs"/u);
    expect(watchSchema).toMatch(/pgTable\(\s*"case_watch_findings"/u);
    expect(watchSchema.match(/onDelete: "cascade"/g)).toHaveLength(4);
    expect(watchSchema).toContain("case_watch_settings_case_id_unique");
    expect(watchSchema).toContain(
      "case_watch_findings_watch_id_source_key_unique",
    );
    expect(watchRunSchema).toContain(
      'monitoringFromDate: text("monitoring_from_date").notNull()',
    );
  });

  it("locks and fixes base plus upper cursors in one start transaction", async () => {
    const repository = await source(REPOSITORY_URL);
    const startRun = methodBlock(repository, "startRun", "findDocumentsForRun");

    expect(startRun).toContain("db.transaction(async (tx)");
    expect(startRun).toContain('.for("update")');
    expect(startRun).toContain('eq(caseWatchRuns.status, "running")');
    expect(startRun).toContain("desc(kohoImportRuns.updatedAt)");
    expect(startRun).toContain("desc(kohoImportRuns.importId)");
    expect(startRun).toContain("pg_advisory_xact_lock");
    expect(startRun).toContain("baseCursorRunUpdatedAt");
    expect(startRun).toContain("upperCursorRunUpdatedAt");
    expect(startRun).toContain(
      "monitoringFromDate: setting.monitoringFromDate",
    );
    expect(startRun).toMatch(/tx\s*\.insert\(caseWatchRuns\)/);
    expect(startRun).not.toMatch(
      /\bdb\s*\.\s*(?:select|insert|update|delete)\b/,
    );
  });

  it("recovers stale running runs without advancing the cursor", async () => {
    const repository = await source(REPOSITORY_URL);
    const startRun = methodBlock(repository, "startRun", "findDocumentsForRun");
    const recoveryIndex = startRun.indexOf(".update(caseWatchRuns)");
    const recoveryEndIndex = startRun.indexOf("const [runningRow]", recoveryIndex);
    const activeRunCheckIndex = startRun.indexOf(
      ".select({ runId: caseWatchRuns.runId })",
    );
    const recovery = startRun.slice(recoveryIndex, recoveryEndIndex);

    expect(repository).toContain(
      "const PATENT_WATCH_STALE_RUN_TIMEOUT_MINUTES = 5;",
    );
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryEndIndex).toBeGreaterThan(recoveryIndex);
    expect(activeRunCheckIndex).toBeGreaterThan(recoveryIndex);
    expect(recovery).toContain("caseWatchRuns.watchId");
    expect(recovery).toContain('eq(caseWatchRuns.status, "running")');
    expect(recovery).toContain("lt(");
    expect(recovery).toContain("caseWatchRuns.startedAt");
    expect(recovery).toContain("interval '1 minute'");
    expect(recovery).toContain('status: "failed"');
    expect(recovery).toContain("completedAt: sql`now()`");
    expect(recovery).toContain('errorCode: "watch_internal_error"');
    expect(startRun).not.toMatch(/tx\s*\.update\(caseWatchSettings\)/);
  });

  it("serializes import persistence with upper capture and assigns a monotonic cursor", async () => {
    const repository = await source(REPOSITORY_URL);
    const savePlanStart = repository.indexOf("async savePlan");
    const savePlanEnd = repository.indexOf(
      "async findRunBySource",
      savePlanStart,
    );
    const savePlan = repository.slice(savePlanStart, savePlanEnd);
    const startRun = methodBlock(repository, "startRun", "findDocumentsForRun");

    expect(savePlanStart).toBeGreaterThanOrEqual(0);
    expect(savePlanEnd).toBeGreaterThan(savePlanStart);
    expect(savePlan).toContain("pg_advisory_xact_lock");
    expect(startRun).toContain("pg_advisory_xact_lock");
    expect(savePlan).toContain("clock_timestamp()");
    expect(savePlan).toContain("interval '1 microsecond'");
    expect(savePlan).toContain("desc(kohoImportRuns.updatedAt)");
  });

  it("reads only the fixed tuple range and exposes source-key lookup", async () => {
    const repository = await source(REPOSITORY_URL);
    const documents = methodBlock(
      repository,
      "findDocumentsForRun",
      "findExistingSourceKeys",
    );
    const sourceKeys = methodBlock(
      repository,
      "findExistingSourceKeys",
      "finalizeRunSuccess",
    );

    expect(documents).toContain("kohoImportRuns.updatedAt");
    expect(documents).toContain("kohoImportRuns.importId");
    expect(documents).toContain("monitoringFromDate");
    expect(documents).toContain("run.monitoringFromDate");
    expect(documents).not.toContain("setting.monitoringFromDate");
    expect(documents).toContain("asc(kohoImportRuns.updatedAt)");
    expect(documents).toContain("asc(kohoImportRuns.importId)");
    expect(documents).toContain("asc(kohoImportDocuments.documentId)");
    expect(sourceKeys).toContain("caseWatchFindings.sourceKey");
    expect(sourceKeys).toContain("inArray(caseWatchFindings.sourceKey,");
  });

  it("atomically finalizes success and never advances the cursor on failure", async () => {
    const repository = await source(REPOSITORY_URL);
    const success = methodBlock(
      repository,
      "finalizeRunSuccess",
      "finalizeRunFailure",
    );
    const failure = methodBlock(repository, "finalizeRunFailure", "getRun");

    expect(success).toContain("db.transaction(async (tx)");
    expect(success.indexOf(".from(caseWatchSettings)")).toBeLessThan(
      success.indexOf(".from(caseWatchRuns)"),
    );
    expect(success.match(/\.for\("update"\)/g)).toHaveLength(2);
    expect(success).toMatch(/tx\s*\.insert\(caseWatchFindings\)/);
    expect(success.indexOf('run.status !== "running"')).toBeLessThan(
      success.indexOf(".insert(caseWatchFindings)"),
    );
    expect(success).toContain("onConflictDoNothing");
    expect(success).toContain('status: "completed"');
    expect(success).toMatch(/tx\s*\.update\(caseWatchSettings\)/);
    expect(success).not.toMatch(
      /\bdb\s*\.\s*(?:select|insert|update|delete)\b/,
    );

    expect(failure).toContain("db.transaction(async (tx)");
    expect(failure.indexOf(".from(caseWatchSettings)")).toBeLessThan(
      failure.indexOf(".from(caseWatchRuns)"),
    );
    expect(failure.match(/\.for\("update"\)/g)).toHaveLength(2);
    expect(failure).toContain('status: "failed"');
    expect(failure).not.toMatch(/tx\s*\.update\(caseWatchSettings\)/);
  });

  it("orders bounded history and enforces the case boundary on review", async () => {
    const repository = await source(REPOSITORY_URL);
    const runs = methodBlock(repository, "listRuns", "listFindings");
    const findings = methodBlock(
      repository,
      "listFindings",
      "countUnreviewedFindings",
    );
    const unreviewed = methodBlock(
      repository,
      "countUnreviewedFindings",
      "updateFindingReviewStatus",
    );
    const review = methodBlock(repository, "updateFindingReviewStatus");

    expect(runs).toContain("desc(caseWatchRuns.startedAt)");
    expect(runs).toContain("desc(caseWatchRuns.runId)");
    expect(runs).toContain(".limit(limit)");
    expect(findings).toContain("desc(caseWatchFindings.firstSeenAt)");
    expect(findings).toContain("desc(caseWatchFindings.findingId)");
    expect(findings).toContain(".limit(limit)");
    expect(unreviewed).toContain(
      'eq(caseWatchFindings.reviewStatus, "unreviewed")',
    );
    expect(review).toContain("eq(caseWatchSettings.caseId, caseId)");
    expect(review).toContain("eq(caseWatchFindings.findingId, findingId)");
  });
});
