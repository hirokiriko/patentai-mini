import { describe, expect, it } from "vitest";

import type { ComparisonResult } from "../analyze-overlap";
import {
  comparePatentWatchCursors,
  createPatentWatchSourceKey,
  PatentWatchDomainError,
} from "./domain";
import { runPatentWatch } from "./service";
import type {
  CaseWatchFinding,
  CaseWatchRun,
  PatentWatchAnalysisDependencies,
  PatentWatchCorpusBatch,
  PatentWatchCorpusDocument,
  PatentWatchCursor,
  PatentWatchRunFailureInput,
  PatentWatchRunRepository,
  PatentWatchRunStart,
  PatentWatchRunSuccessInput,
} from "./types";

const CASE_ID = 7;
const WATCH_ID = 11;
const MONITORING_FROM_DATE = "20960101";
const EXTRACTED_CLAIMS_JSON = JSON.stringify({
  title: "完全に架空の軌道プリズム",
  abstract: "完全に架空の要約",
  solvedProblems: [],
  effects: [],
  claims: [
    {
      claimNo: 1,
      text: "orbital prism detector controller",
      isIndependent: true,
      dependsOn: null,
      elements: [
        {
          type: "component",
          text: "orbital prism detector",
          importance: "core",
        },
      ],
    },
  ],
});

type ImportFixture = {
  cursor: PatentWatchCursor;
  documents: PatentWatchCorpusDocument[];
};

type FinalizeFailureStage =
  | "after_finding_insert"
  | "after_run_complete"
  | "after_cursor_update";

type StoreSnapshot = {
  cursor: PatentWatchCursor | null;
  runs: Array<[number, CaseWatchRun]>;
  findings: Array<[string, CaseWatchFinding]>;
  nextFindingId: number;
};

function cloneCursor(value: PatentWatchCursor | null): PatentWatchCursor | null {
  return value === null ? null : { ...value };
}

function cursorFromRun(
  run: CaseWatchRun,
  kind: "base" | "upper",
): PatentWatchCursor | null {
  const runUpdatedAt =
    kind === "base" ? run.baseRunUpdatedAt : run.upperRunUpdatedAt;
  const importId = kind === "base" ? run.baseImportId : run.upperImportId;
  return runUpdatedAt === null || importId === null
    ? null
    : { runUpdatedAt, importId };
}

function isAfterBaseAndThroughUpper(
  cursor: PatentWatchCursor,
  base: PatentWatchCursor | null,
  upper: PatentWatchCursor,
): boolean {
  return (
    (base === null || comparePatentWatchCursors(cursor, base) > 0) &&
    comparePatentWatchCursors(cursor, upper) <= 0
  );
}

class StatefulTransactionalWatchRepository
  implements PatentWatchRunRepository
{
  private readonly imports: ImportFixture[] = [];
  private readonly runStore = new Map<number, CaseWatchRun>();
  private readonly findingStore = new Map<string, CaseWatchFinding>();
  private settingCursor: PatentWatchCursor | null = null;
  private settingMonitoringFromDate = MONITORING_FROM_DATE;
  private nextRunId = 1;
  private nextFindingId = 1;
  private beforeDocumentRead: (() => void | Promise<void>) | null = null;
  private documentReadError: unknown;
  private finalizeFailureStage: FinalizeFailureStage | null = null;

  addImport(
    cursor: PatentWatchCursor,
    documents: readonly PatentWatchCorpusDocument[],
  ): void {
    this.imports.push({
      cursor: { ...cursor },
      documents: documents.map((document) => ({
        ...structuredClone(document),
        importId: cursor.importId,
        importRunUpdatedAt: cursor.runUpdatedAt,
      })),
    });
  }

  beforeNextDocumentRead(action: () => void | Promise<void>): void {
    this.beforeDocumentRead = action;
  }

  updateMonitoringFromDate(value: string): void {
    this.settingMonitoringFromDate = value;
  }

  failNextDocumentRead(error: unknown): void {
    this.documentReadError = error;
  }

  failNextSuccessFinalizeAt(stage: FinalizeFailureStage): void {
    this.finalizeFailureStage = stage;
  }

  cursor(): PatentWatchCursor | null {
    return cloneCursor(this.settingCursor);
  }

  runs(): CaseWatchRun[] {
    return Array.from(this.runStore.values())
      .sort((left, right) => left.runId - right.runId)
      .map((run) => structuredClone(run));
  }

  findings(): CaseWatchFinding[] {
    return Array.from(this.findingStore.values())
      .sort((left, right) => left.findingId - right.findingId)
      .map((finding) => structuredClone(finding));
  }

  private captureStore(): StoreSnapshot {
    return {
      cursor: cloneCursor(this.settingCursor),
      runs: Array.from(this.runStore.entries()).map(([runId, run]) => [
        runId,
        structuredClone(run),
      ]),
      findings: Array.from(this.findingStore.entries()).map(
        ([sourceKey, finding]) => [sourceKey, structuredClone(finding)],
      ),
      nextFindingId: this.nextFindingId,
    };
  }

  private restoreStore(snapshot: StoreSnapshot): void {
    this.settingCursor = cloneCursor(snapshot.cursor);
    this.runStore.clear();
    for (const [runId, run] of snapshot.runs) {
      this.runStore.set(runId, structuredClone(run));
    }
    this.findingStore.clear();
    for (const [sourceKey, finding] of snapshot.findings) {
      this.findingStore.set(sourceKey, structuredClone(finding));
    }
    this.nextFindingId = snapshot.nextFindingId;
  }

  async startRun(caseId: number): Promise<PatentWatchRunStart> {
    if (caseId !== CASE_ID) {
      throw new PatentWatchDomainError("case_not_found");
    }
    if (this.runs().some((run) => run.status === "running")) {
      throw new PatentWatchDomainError("watch_run_in_progress");
    }

    const sortedImports = [...this.imports].sort((left, right) =>
      comparePatentWatchCursors(left.cursor, right.cursor),
    );
    const upperCursor =
      sortedImports.length === 0
        ? null
        : cloneCursor(sortedImports[sortedImports.length - 1].cursor);
    const baseCursor = cloneCursor(this.settingCursor);
    const monitoringFromDate = this.settingMonitoringFromDate;
    const runId = this.nextRunId;
    this.nextRunId += 1;
    const startedAt = `2096-06-01T00:00:${String(runId).padStart(2, "0")}.000Z`;

    this.runStore.set(runId, {
      runId,
      watchId: WATCH_ID,
      status: "running",
      monitoringFromDate,
      baseRunUpdatedAt: baseCursor?.runUpdatedAt ?? null,
      baseImportId: baseCursor?.importId ?? null,
      upperRunUpdatedAt: upperCursor?.runUpdatedAt ?? null,
      upperImportId: upperCursor?.importId ?? null,
      startedAt,
      completedAt: null,
      scannedImportRunCount: 0,
      scannedDocumentCount: 0,
      prefilteredCount: 0,
      analyzedCount: 0,
      newFindingCount: 0,
      fallbackFindingCount: 0,
      analysisMode: "none",
      errorCode: null,
    });

    return {
      caseId,
      watchId: WATCH_ID,
      runId,
      monitoringFromDate,
      baseCursor,
      upperCursor,
      extractedClaimsJson: EXTRACTED_CLAIMS_JSON,
    };
  }

  async findDocumentsForRun(runId: number): Promise<PatentWatchCorpusBatch> {
    const run = this.runStore.get(runId);
    if (!run || run.status !== "running") {
      throw new PatentWatchDomainError("watch_run_not_found");
    }

    const beforeRead = this.beforeDocumentRead;
    this.beforeDocumentRead = null;
    if (beforeRead) await beforeRead();

    if (this.documentReadError !== undefined) {
      const error = this.documentReadError;
      this.documentReadError = undefined;
      throw error;
    }

    const baseCursor = cursorFromRun(run, "base");
    const upperCursor = cursorFromRun(run, "upper");
    if (upperCursor === null) {
      return {
        documents: [],
        scannedImportRunCount: 0,
        scannedDocumentCount: 0,
      };
    }

    const selectedImports = this.imports
      .filter((item) =>
        isAfterBaseAndThroughUpper(item.cursor, baseCursor, upperCursor),
      )
      .sort((left, right) =>
        comparePatentWatchCursors(left.cursor, right.cursor),
      );
    const documents = selectedImports.flatMap((item) =>
      item.documents
        .filter(
          (document) =>
            baseCursor !== null ||
            document.publicationDate >= run.monitoringFromDate,
        )
        .map((document) => structuredClone(document)),
    );

    return {
      documents,
      scannedImportRunCount: selectedImports.length,
      scannedDocumentCount: documents.length,
    };
  }

  async findExistingSourceKeys(
    watchId: number,
    sourceKeys: readonly string[],
  ): Promise<readonly string[]> {
    if (watchId !== WATCH_ID) {
      throw new PatentWatchDomainError("watch_not_configured");
    }
    return sourceKeys.filter((sourceKey) => this.findingStore.has(sourceKey));
  }

  async finalizeRunSuccess(
    input: PatentWatchRunSuccessInput,
  ): Promise<CaseWatchRun> {
    const snapshot = this.captureStore();
    const failureStage = this.finalizeFailureStage;
    this.finalizeFailureStage = null;
    try {
      const run = this.runStore.get(input.runId);
      if (
        input.caseId !== CASE_ID ||
        !run ||
        run.status !== "running"
      ) {
        throw new PatentWatchDomainError("watch_run_not_found");
      }

      const inserted: CaseWatchFinding[] = [];
      for (const finding of input.findings) {
        if (this.findingStore.has(finding.sourceKey)) continue;
        const stored: CaseWatchFinding = {
          ...structuredClone(finding),
          findingId: this.nextFindingId,
          watchId: WATCH_ID,
          firstRunId: input.runId,
          firstSeenAt: `2096-06-01T01:00:${String(this.nextFindingId).padStart(2, "0")}.000Z`,
        };
        this.nextFindingId += 1;
        this.findingStore.set(stored.sourceKey, stored);
        inserted.push(stored);
      }
      if (failureStage === "after_finding_insert") {
        throw new Error("FICTIONAL-TRANSACTION-FAILURE");
      }

      const completed: CaseWatchRun = {
        ...run,
        status: "completed",
        completedAt: `2096-06-01T02:00:${String(run.runId).padStart(2, "0")}.000Z`,
        ...input.counts,
        newFindingCount: inserted.length,
        fallbackFindingCount: inserted.filter(
          (finding) => finding.analysisMode === "fallback",
        ).length,
        analysisMode: input.analysisMode,
        errorCode: null,
      };
      this.runStore.set(run.runId, completed);
      if (failureStage === "after_run_complete") {
        throw new Error("FICTIONAL-TRANSACTION-FAILURE");
      }

      this.settingCursor = cursorFromRun(run, "upper");
      if (failureStage === "after_cursor_update") {
        throw new Error("FICTIONAL-TRANSACTION-FAILURE");
      }
      return structuredClone(completed);
    } catch (error) {
      this.restoreStore(snapshot);
      throw error;
    }
  }

  async finalizeRunFailure(
    input: PatentWatchRunFailureInput,
  ): Promise<CaseWatchRun> {
    const run = this.runStore.get(input.runId);
    if (
      input.caseId !== CASE_ID ||
      !run ||
      run.status !== "running"
    ) {
      throw new PatentWatchDomainError("watch_run_not_found");
    }
    const failed: CaseWatchRun = {
      ...run,
      status: "failed",
      completedAt: `2096-06-01T03:00:${String(run.runId).padStart(2, "0")}.000Z`,
      errorCode: input.errorCode,
    };
    this.runStore.set(run.runId, failed);
    return structuredClone(failed);
  }
}

function corpusDocument(
  documentId: number,
  publicationNumber: string,
  contentSha256: string,
  overrides: Partial<PatentWatchCorpusDocument> = {},
): PatentWatchCorpusDocument {
  return {
    documentId,
    importId: 1,
    importRunUpdatedAt: "2096-03-01T00:00:00.000Z",
    packageType: "JPA",
    kind: "A1",
    publicationNumber,
    publicationDate: "20960301",
    inventionTitle: "orbital prism detector",
    abstractText: "fictional orbital prism abstract",
    claimsText: "orbital prism detector controller",
    contentSha256,
    ...overrides,
  };
}

function cursor(runUpdatedAt: string, importId: number): PatentWatchCursor {
  return { runUpdatedAt, importId };
}

function comparison(priorDocId: number): ComparisonResult {
  return {
    draftClaimNo: 1,
    priorDocId,
    lexicalScore: 0.9,
    elementScore: 0.8,
    semanticScore: 0.7,
    structuralScore: 0.6,
    matchedElements: ["orbital prism"],
    unmatchedElements: ["fictional constraint"],
    riskLabel: "Medium",
    explanation: "重なり候補です。人による確認が必要です",
  };
}

function dependencies(
  repository: StatefulTransactionalWatchRepository,
  screenedDocumentIds: number[][] = [],
): PatentWatchAnalysisDependencies {
  return {
    repository,
    screenPriorArt: async (_claims, priorArts) => {
      screenedDocumentIds.push(priorArts.map((priorArt) => priorArt.docId));
      return {
        relevantDocIds: priorArts.map((priorArt) => priorArt.docId),
        reasoning: "completely fictional screening",
      };
    },
    analyzeOverlap: async (_claims, priorArts) =>
      priorArts.map((priorArt) => comparison(priorArt.docId)),
  };
}

describe("patent watch stateful workflow", () => {
  it("keeps the run-start monitoring date when PUT changes the setting before document read", async () => {
    const repository = new StatefulTransactionalWatchRepository();
    const firstCursor = cursor("2096-03-01T00:00:00.000Z", 1);
    repository.addImport(firstCursor, [
      corpusDocument(100, "JP2096-000100A", "0".repeat(64), {
        publicationDate: MONITORING_FROM_DATE,
      }),
    ]);
    repository.beforeNextDocumentRead(() => {
      repository.updateMonitoringFromDate("20970101");
    });
    const screened: number[][] = [];

    const completed = await runPatentWatch(
      CASE_ID,
      dependencies(repository, screened),
    );

    expect(completed.monitoringFromDate).toBe(MONITORING_FROM_DATE);
    expect(completed.newFindingCount).toBe(1);
    expect(repository.cursor()).toEqual(firstCursor);
    expect(screened).toEqual([[100]]);
  });

  it("freezes upper, leaves a later import for the next run, and advances each successful cursor", async () => {
    const repository = new StatefulTransactionalWatchRepository();
    const firstCursor = cursor("2096-03-01T00:00:00.000Z", 1);
    const secondCursor = cursor("2096-03-02T00:00:00.000Z", 2);
    repository.addImport(firstCursor, [
      corpusDocument(101, "JP2096-000101A", "a".repeat(64)),
    ]);
    repository.beforeNextDocumentRead(() => {
      repository.addImport(secondCursor, [
        corpusDocument(102, "JP2096-000102A", "b".repeat(64)),
      ]);
    });
    const screened: number[][] = [];

    const firstRun = await runPatentWatch(
      CASE_ID,
      dependencies(repository, screened),
    );

    expect(firstRun.status).toBe("completed");
    expect(firstRun.upperImportId).toBe(1);
    expect(firstRun.newFindingCount).toBe(1);
    expect(repository.cursor()).toEqual(firstCursor);
    expect(screened).toEqual([[101]]);

    const secondRun = await runPatentWatch(
      CASE_ID,
      dependencies(repository, screened),
    );

    expect(secondRun.status).toBe("completed");
    expect(secondRun.baseImportId).toBe(1);
    expect(secondRun.upperImportId).toBe(2);
    expect(secondRun.newFindingCount).toBe(1);
    expect(repository.cursor()).toEqual(secondCursor);
    expect(screened).toEqual([[101], [102]]);
  });

  it("keeps the successful cursor unchanged when a later run fails", async () => {
    const repository = new StatefulTransactionalWatchRepository();
    const successfulCursor = cursor("2096-03-01T00:00:00.000Z", 1);
    repository.addImport(successfulCursor, [
      corpusDocument(111, "JP2096-000111A", "c".repeat(64)),
    ]);
    await runPatentWatch(CASE_ID, dependencies(repository));

    repository.addImport(cursor("2096-03-02T00:00:00.000Z", 2), [
      corpusDocument(112, "JP2096-000112A", "d".repeat(64)),
    ]);
    repository.failNextDocumentRead(
      new Error("FICTIONAL-DOCUMENT-READ-FAILURE"),
    );

    await expect(
      runPatentWatch(CASE_ID, dependencies(repository)),
    ).rejects.toMatchObject({ code: "watch_internal_error" });

    expect(repository.cursor()).toEqual(successfulCursor);
    const runs = repository.runs();
    expect(runs[runs.length - 1]).toMatchObject({
      status: "failed",
      errorCode: "watch_internal_error",
      baseImportId: 1,
      upperImportId: 2,
    });
  });

  it("rejects one of two starts while the first run remains running", async () => {
    const repository = new StatefulTransactionalWatchRepository();

    const firstStart = repository.startRun(CASE_ID);
    const concurrentStart = repository.startRun(CASE_ID);
    const results = await Promise.allSettled([firstStart, concurrentStart]);

    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { runId: 1 },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "watch_run_in_progress" },
    });
    expect(repository.runs().filter((run) => run.status === "running")).toHaveLength(1);
  });

  it.each([
    "after_finding_insert",
    "after_run_complete",
    "after_cursor_update",
  ] as const)(
    "rolls back every partial success mutation when finalize fails %s",
    async (failureStage: FinalizeFailureStage) => {
      const repository = new StatefulTransactionalWatchRepository();
      const source = corpusDocument(
        121,
        "JP2096-000121A",
        "e".repeat(64),
      );
      repository.addImport(
        cursor("2096-03-01T00:00:00.000Z", 1),
        [source],
      );
      repository.failNextSuccessFinalizeAt(failureStage);

      await expect(
        runPatentWatch(CASE_ID, dependencies(repository)),
      ).rejects.toMatchObject({ code: "watch_internal_error" });

      expect(repository.cursor()).toBeNull();
      expect(repository.findings()).toEqual([]);
      expect(repository.runs()).toEqual([
        expect.objectContaining({
          status: "failed",
          newFindingCount: 0,
          analysisMode: "none",
          errorCode: "watch_internal_error",
        }),
      ]);
    },
  );

  it("deduplicates a reimport with changed IDs and package but accepts a changed digest", async () => {
    const repository = new StatefulTransactionalWatchRepository();
    const publicationNumber = "JP2096-000131A";
    const originalDigest = "f".repeat(64);
    const changedDigest = "1".repeat(64);
    repository.addImport(cursor("2096-03-01T00:00:00.000Z", 1), [
      corpusDocument(131, publicationNumber, originalDigest),
    ]);
    const screened: number[][] = [];

    const firstRun = await runPatentWatch(
      CASE_ID,
      dependencies(repository, screened),
    );

    repository.addImport(cursor("2096-03-02T00:00:00.000Z", 2), [
      corpusDocument(9131, publicationNumber, originalDigest, {
        packageType: "JPB",
        kind: "B1",
      }),
    ]);
    const reimportRun = await runPatentWatch(
      CASE_ID,
      dependencies(repository, screened),
    );

    repository.addImport(cursor("2096-03-03T00:00:00.000Z", 3), [
      corpusDocument(10131, publicationNumber, changedDigest),
    ]);
    const changedContentRun = await runPatentWatch(
      CASE_ID,
      dependencies(repository, screened),
    );

    expect(firstRun.newFindingCount).toBe(1);
    expect(reimportRun.newFindingCount).toBe(0);
    expect(reimportRun.analysisMode).toBe("none");
    expect(changedContentRun.newFindingCount).toBe(1);
    expect(repository.findings()).toHaveLength(2);
    expect(repository.findings().map((finding) => finding.sourceKey)).toEqual([
      createPatentWatchSourceKey(publicationNumber, originalDigest),
      createPatentWatchSourceKey(publicationNumber, changedDigest),
    ]);
    expect(screened).toEqual([[131], [10131]]);
  });
});
