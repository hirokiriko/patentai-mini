import { describe, expect, it, vi } from "vitest";
import { AiOperationBudget, AiOperationStopped } from "../ai-operation-budget";

import type { ExtractedClaims } from "../extract-claims";
import { createPatentWatchSourceKey } from "./domain";
import { createPatentWatchRunHandlers } from "./api";
import {
  PATENT_WATCH_FALLBACK_EXPLANATION,
  runPatentWatch,
} from "./service";
import type {
  CaseWatchRun,
  PatentWatchAnalysisDetail,
  PatentWatchCorpusBatch,
  PatentWatchCorpusDocument,
  PatentWatchRunFailureInput,
  PatentWatchRunRepository,
  PatentWatchRunStart,
  PatentWatchRunSuccessInput,
  PatentWatchScreeningSummary,
} from "./types";

const CLAIMS: ExtractedClaims = {
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
        { type: "component", text: "orbital prism", importance: "core" },
        { type: "action", text: "detector controller", importance: "core" },
      ],
    },
  ],
};

function source(
  documentId: number,
  overrides: Partial<PatentWatchCorpusDocument> = {},
): PatentWatchCorpusDocument {
  return {
    documentId,
    importId: documentId,
    importRunUpdatedAt: `2096-03-${String(Math.min(documentId, 28)).padStart(2, "0")}T00:00:00.000Z`,
    packageType: "JPA",
    kind: "A1",
    publicationNumber: `JP2096-${String(documentId).padStart(6, "0")}A`,
    publicationDate: "20960301",
    inventionTitle: "orbital prism detector",
    abstractText: "fictional abstract",
    claimsText: "orbital prism detector controller",
    contentSha256: documentId.toString(16).padStart(64, "0"),
    ...overrides,
  };
}

function completedRun(input: PatentWatchRunSuccessInput): CaseWatchRun {
  return {
    runId: input.runId,
    watchId: 11,
    status: "completed",
    monitoringFromDate: "20960301",
    baseRunUpdatedAt: null,
    baseImportId: null,
    upperRunUpdatedAt: "2096-03-20T00:00:00.000Z",
    upperImportId: 20,
    startedAt: "2096-03-20T01:00:00.000Z",
    completedAt: "2096-03-20T01:00:01.000Z",
    ...input.counts,
    analysisMode: input.analysisMode,
    errorCode: null,
  };
}

class FakeRunRepository implements PatentWatchRunRepository {
  readonly success: PatentWatchRunSuccessInput[] = [];
  readonly failure: PatentWatchRunFailureInput[] = [];
  readonly requestedKeys: string[][] = [];

  constructor(
    readonly start: PatentWatchRunStart,
    readonly batch: PatentWatchCorpusBatch,
    readonly existing: readonly string[] = [],
    readonly documentsError: Error | null = null,
  ) {}

  async startRun(): Promise<PatentWatchRunStart> {
    return structuredClone(this.start);
  }

  async findDocumentsForRun(): Promise<PatentWatchCorpusBatch> {
    if (this.documentsError) throw this.documentsError;
    return structuredClone(this.batch);
  }

  async findExistingSourceKeys(
    _watchId: number,
    sourceKeys: readonly string[],
  ): Promise<readonly string[]> {
    this.requestedKeys.push([...sourceKeys]);
    return [...this.existing];
  }

  async finalizeRunSuccess(
    input: PatentWatchRunSuccessInput,
  ): Promise<CaseWatchRun> {
    this.success.push(structuredClone(input));
    return completedRun(input);
  }

  async finalizeRunFailure(
    input: PatentWatchRunFailureInput,
  ): Promise<void> {
    this.failure.push({ ...input });
  }
}

function start(
  overrides: Partial<PatentWatchRunStart> = {},
): PatentWatchRunStart {
  return {
    caseId: 7,
    watchId: 11,
    runId: 13,
    monitoringFromDate: "20960301",
    baseCursor: null,
    upperCursor: {
      runUpdatedAt: "2096-03-20T00:00:00.000Z",
      importId: 20,
    },
    extractedClaimsJson: JSON.stringify(CLAIMS),
    ...overrides,
  };
}

function batch(
  documents: PatentWatchCorpusDocument[],
): PatentWatchCorpusBatch {
  return {
    documents,
    scannedImportRunCount: new Set(documents.map((item) => item.importId)).size,
    scannedDocumentCount: documents.length,
  };
}

function successfulAnalysis(priorDocId: number) {
  return {
    draftClaimNo: 1,
    priorDocId,
    lexicalScore: 0.9,
    elementScore: 0.8,
    semanticScore: 0.7,
    structuralScore: 0.6,
    matchedElements: ["orbital prism"],
    unmatchedElements: ["fictional constraint"],
    riskLabel: "Medium" as const,
    explanation: "重なり候補です。人による確認が必要です",
  };
}

describe("patent watch run service", () => {
  it.each(["screening", "detail"] as const)("keeps the %s input refusal through failure finalization and the HTTP response", async stage => {
    const repository = new FakeRunRepository(start(), batch([source(10)]));
    const transport = vi.fn<typeof fetch>();
    const stop = () => new AiOperationBudget({ normal: 6, fast: 0 }).wrapFetch("normal", transport)(
      "https://example.invalid/responses", { method: "POST", body: JSON.stringify({
        model: "fictional", input: [{ role: "user", content: "文".repeat(50_000) }],
        max_output_tokens: 8192, text: { format: { type: "json_schema", schema: { type: "object" } } },
      }) });
    const handler = createPatentWatchRunHandlers({ executeRun: caseId => runPatentWatch(caseId, {
      repository,
      screenPriorArt: async () => {
        if (stage === "screening") await stop();
        return { relevantDocIds: [10], reasoning: "fictional" };
      },
      analyzeOverlap: async () => { await stop(); return []; },
    }) });
    const response = await handler.POST(new Request("https://example.invalid/api/cases/7/watch/runs", {
      method: "POST", headers: { "X-Patent-Watch-Diagnostic-Id": "FICTIONAL-UNTRUSTED-ID" },
    }), { params: Promise.resolve({ caseId: "7" }) });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: "watch_ai_stopped", diagnostic: { stage, reason: "input_limit" } });
    expect(body.diagnostic.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(response.headers.get("X-Patent-Watch-Diagnostic-Id")).toBe(body.diagnostic.id);
    expect(repository.success).toEqual([]);
    expect(repository.failure).toEqual([{ caseId: 7, runId: 13, errorCode: "watch_ai_stopped" }]);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["input_limit", "usage_missing", "timeout", "body_timeout"])("fails closed through the real budget for %s", async scenario => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("FICTIONAL_SECRET", "TimeoutError")), ms);
      return controller.signal;
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const budget = new AiOperationBudget({ normal: 3, fast: 3 });
    let late!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (scenario === "timeout") return new Promise(resolve => { late = resolve; });
      if (scenario === "body_timeout") return {
        ok: true, clone: () => ({ json: () => new Promise(() => {}) }),
      } as unknown as Response;
      return Response.json({ message: "FICTIONAL_SECRET" }, { headers: { authorization: "FICTIONAL_SECRET" } });
    });
    const request = { method: "POST", body: JSON.stringify({
      model: "fictional", input: [{ role: "user", content: scenario === "input_limit" ? "文".repeat(50_000) : "fictional" }],
      max_output_tokens: 8192, text: { format: { type: "json_schema", schema: { type: "object" } } },
    }) };
    const repository = new FakeRunRepository(start(), batch([source(10)]));
    const screen = vi.fn(async () => {
      await budget.wrapFetch("fast", transport)("https://example.invalid/responses", request);
      return { relevantDocIds: [10], reasoning: "fictional" };
    });
    const analyze = vi.fn(async () => [successfulAnalysis(10)]);
    try {
      const stopped = runPatentWatch(7, { repository, screenPriorArt: screen, analyzeOverlap: analyze }).catch(error => error);
      await vi.advanceTimersByTimeAsync(35_000);
      const error = await stopped;
      expect(error).toMatchObject({ code: "watch_ai_stopped" });
      expect(repository.success).toEqual([]);
      expect(repository.failure).toEqual([{ caseId: 7, runId: 13, errorCode: "watch_ai_stopped" }]);
      expect(analyze).not.toHaveBeenCalled();
      if (late) late(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
      for (const role of ["normal", "fast"] as const) {
        await expect(budget.wrapFetch(role, transport)("https://example.invalid/responses", request)).rejects.toBeInstanceOf(AiOperationStopped);
      }
      expect(transport).toHaveBeenCalledTimes(scenario === "input_limit" ? 0 : 1);
      expect(JSON.stringify(info.mock.calls)).not.toContain("FICTIONAL_SECRET");
      expect(JSON.stringify(error)).not.toContain("FICTIONAL_SECRET");
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each(["screening", "detail", "timeout"])("fails %s budget/timeout without fallback or cursor success", async stage => {
    const repository = new FakeRunRepository(start(), batch([source(10)]));
    const stop = stage === "timeout" ? new DOMException("fictional", "TimeoutError") : new AiOperationStopped();
    const screen = vi.fn(async () => { if (stage !== "detail") throw stop; return { relevantDocIds: [10], reasoning: "fictional" }; });
    const analyze = vi.fn(async () => { throw stop; });
    await expect(runPatentWatch(7, { repository, screenPriorArt: screen, analyzeOverlap: analyze })).rejects.toMatchObject({ code: "watch_ai_stopped" });
    expect(analyze).toHaveBeenCalledTimes(stage === "detail" ? 1 : 0);
    expect(repository.failure[0]).toEqual({ caseId: 7, runId: 13, errorCode: "watch_ai_stopped" });
    expect(repository.success).toHaveLength(0); expect(repository.failure).toHaveLength(1);
  });
  it("makes no AI sends when a completed cursor has no new import", async () => {
    const current = start();
    const repository = new FakeRunRepository(start({ baseCursor: current.upperCursor }), batch([source(10)]));
    const screen = vi.fn(), analyze = vi.fn();
    await runPatentWatch(7, { repository, screenPriorArt: screen, analyzeOverlap: analyze });
    expect(screen).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled();
    expect(repository.success[0].findings).toHaveLength(0);
  });
  it("uses the fixed upper cursor and initial monitoring date", async () => {
    const inScope = source(10);
    const beforeMonitoring = source(11, { publicationDate: "20960228" });
    const afterUpper = source(21, {
      importRunUpdatedAt: "2096-03-21T00:00:00.000Z",
    });
    const repository = new FakeRunRepository(
      start(),
      batch([afterUpper, beforeMonitoring, inScope]),
    );
    const screen = vi.fn(async (
      _claims: ExtractedClaims,
      priorArts: PatentWatchScreeningSummary[],
    ) => ({
      relevantDocIds: priorArts.map((item) => item.docId),
      reasoning: "fictional screening",
    }));
    const analyze = vi.fn(async () => [successfulAnalysis(10)]);

    await runPatentWatch(7, {
      repository,
      screenPriorArt: screen,
      analyzeOverlap: analyze,
    });

    expect(screen).toHaveBeenCalledTimes(1);
    expect(screen.mock.calls[0][1]).toEqual([
      {
        docId: 10,
        publicationNo: inScope.publicationNumber,
        title: inScope.inventionTitle,
        abstract: inScope.abstractText,
      },
    ]);
    expect(repository.success[0].findings).toHaveLength(1);
  });

  it("uses only tuples greater than base and at most upper on later runs", async () => {
    const repository = new FakeRunRepository(
      start({
        baseCursor: {
          runUpdatedAt: "2096-03-10T00:00:00.000Z",
          importId: 10,
        },
      }),
      batch([
        source(9, { importRunUpdatedAt: "2096-03-10T00:00:00.000Z" }),
        source(10, { importRunUpdatedAt: "2096-03-10T00:00:00.000Z" }),
        source(11, { importRunUpdatedAt: "2096-03-10T00:00:00.000Z" }),
        source(20, { importRunUpdatedAt: "2096-03-20T00:00:00.000Z" }),
        source(21, { importRunUpdatedAt: "2096-03-20T00:00:00.000Z" }),
      ]),
    );
    const screen = vi.fn(async (
      _claims: ExtractedClaims,
      priorArts: PatentWatchScreeningSummary[],
    ) => ({
      relevantDocIds: priorArts.map((item) => item.docId),
      reasoning: "fictional screening",
    }));

    await runPatentWatch(7, {
      repository,
      screenPriorArt: screen,
      analyzeOverlap: async () => [],
    });

    expect(screen.mock.calls[0][1].map((item: { docId: number }) => item.docId)).toEqual([
      11,
      20,
    ]);
  });

  it("leaves an import added after the fixed upper cursor for the next run", async () => {
    const nextImport = source(21, {
      importRunUpdatedAt: "2096-03-21T00:00:00.000Z",
    });
    const repository = new FakeRunRepository(
      start({
        baseCursor: {
          runUpdatedAt: "2096-03-20T00:00:00.000Z",
          importId: 20,
        },
        upperCursor: {
          runUpdatedAt: "2096-03-21T00:00:00.000Z",
          importId: 21,
        },
      }),
      batch([nextImport]),
    );
    const screen = vi.fn(async (
      _claims: ExtractedClaims,
      priorArts: PatentWatchScreeningSummary[],
    ) => ({
      relevantDocIds: priorArts.map((item) => item.docId),
      reasoning: "fictional screening",
    }));

    await runPatentWatch(7, {
      repository,
      screenPriorArt: screen,
      analyzeOverlap: async () => [successfulAnalysis(21)],
    });

    expect(screen.mock.calls[0][1].map((item) => item.docId)).toEqual([21]);
    expect(repository.success[0].findings).toHaveLength(1);
  });

  it("does not call AI when no new import is available", async () => {
    const repository = new FakeRunRepository(
      start({ upperCursor: null }),
      batch([]),
    );
    const screen = vi.fn();
    const analyze = vi.fn();

    const run = await runPatentWatch(7, {
      repository,
      screenPriorArt: screen,
      analyzeOverlap: analyze,
    });

    expect(run.status).toBe("completed");
    expect(screen).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(repository.success[0]).toMatchObject({
      findings: [],
      analysisMode: "none",
      counts: {
        prefilteredCount: 0,
        analyzedCount: 0,
        newFindingCount: 0,
        fallbackFindingCount: 0,
      },
    });
  });

  it("passes at most 100 candidates to screening and at most 20 known IDs to analysis", async () => {
    const documents = Array.from({ length: 130 }, (_, index) =>
      source(index + 1),
    );
    const repository = new FakeRunRepository(
      start({
        upperCursor: {
          runUpdatedAt: "2096-04-01T00:00:00.000Z",
          importId: 999,
        },
      }),
      batch(documents),
    );
    const screen = vi.fn(async (
      claims: ExtractedClaims,
      priorArts: PatentWatchScreeningSummary[],
    ) => {
      void claims;
      return {
        relevantDocIds: [
          999_999,
          ...priorArts.map((item) => item.docId),
          priorArts[0].docId,
        ],
        reasoning: "fictional screening",
      };
    });
    const analyze = vi.fn(async (
      claims: ExtractedClaims,
      priorArts: PatentWatchAnalysisDetail[],
    ) => {
      void claims;
      void priorArts;
      return [];
    });

    await runPatentWatch(7, {
      repository,
      screenPriorArt: screen,
      analyzeOverlap: analyze,
    });

    expect(screen.mock.calls[0][1]).toHaveLength(100);
    expect(analyze.mock.calls[0][1]).toHaveLength(20);
    expect(
      analyze.mock.calls[0][1].some(
        (item: { docId: number }) => item.docId === 999_999,
      ),
    ).toBe(false);
  });

  it("ignores an identity already stored for the same watch", async () => {
    const prior = source(1);
    const existingKey = createPatentWatchSourceKey(
      prior.publicationNumber,
      prior.contentSha256,
    );
    const repository = new FakeRunRepository(
      start(),
      batch([prior]),
      [existingKey],
    );
    const screen = vi.fn();

    await runPatentWatch(7, {
      repository,
      screenPriorArt: screen,
      analyzeOverlap: vi.fn(),
    });

    expect(screen).not.toHaveBeenCalled();
    expect(repository.success[0].findings).toEqual([]);
  });

  it("stores AI findings while discarding unknown result IDs and legal conclusions", async () => {
    const repository = new FakeRunRepository(start(), batch([source(1)]));

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => ({
        relevantDocIds: [1],
        reasoning: "fictional screening",
      }),
      analyzeOverlap: async () => [
        successfulAnalysis(999),
        {
          ...successfulAnalysis(1),
          matchedElements: [
            "orbital prism",
            "登録できない",
            "The claim is novel.",
          ],
          explanation: "この請求項は新規ではない",
        },
      ],
    });

    const success = repository.success[0];
    expect(success.analysisMode).toBe("ai");
    expect(success.findings).toHaveLength(1);
    const serialized = JSON.stringify(success.findings[0]);
    expect(serialized).not.toMatch(
      /登録できない|The claim is novel|新規ではない/u,
    );
    expect(serialized).toContain("人による確認が必要です");
  });

  it("bounds stored public metadata by Unicode code point", async () => {
    const repository = new FakeRunRepository(
      start(),
      batch([
        source(1, {
          publicationNumber: `JP${"9".repeat(150)}A`,
          inventionTitle: "架空😀".repeat(250),
        }),
      ]),
    );

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => ({
        relevantDocIds: [1],
        reasoning: "fictional screening",
      }),
      analyzeOverlap: async () => [successfulAnalysis(1)],
    });

    const finding = repository.success[0].findings[0];
    expect(Array.from(finding.publicationNumber)).toHaveLength(100);
    expect(Array.from(finding.inventionTitle)).toHaveLength(500);
  });

  it("does not persist complete draft or source claims echoed by AI", async () => {
    const sourceClaim =
      "orbital prism detector controller with a completely fictional relay";
    const draftEcho = CLAIMS.claims[0].text.toUpperCase();
    const sourceEcho = sourceClaim.toUpperCase();
    const repository = new FakeRunRepository(
      start(),
      batch([
        source(1, {
          claimsText: `${sourceClaim}\n\na second completely fictional claim`,
        }),
      ]),
    );

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => ({
        relevantDocIds: [1],
        reasoning: "fictional screening",
      }),
      analyzeOverlap: async () => [
        {
          ...successfulAnalysis(1),
          matchedElements: [
            draftEcho,
            sourceEcho,
            "orbital prism",
          ],
          explanation: `echoed source: ${sourceEcho}`,
        },
      ],
    });

    const analysisJson = repository.success[0].findings[0].analysisJson;
    expect(analysisJson).not.toContain(draftEcho);
    expect(analysisJson).not.toContain(sourceEcho);
    expect(analysisJson).toContain("orbital prism");
    expect(analysisJson).toContain("人による確認が必要です");
  });

  it("removes a source claim echoed into another candidate result", async () => {
    const firstSourceClaim =
      "orbital prism detector controller with a fictional alpha relay";
    const repository = new FakeRunRepository(
      start(),
      batch([
        source(1, { claimsText: firstSourceClaim }),
        source(2, { claimsText: "orbital prism fictional beta relay" }),
      ]),
    );

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => ({
        relevantDocIds: [1, 2],
        reasoning: "fictional screening",
      }),
      analyzeOverlap: async () => [
        {
          ...successfulAnalysis(2),
          matchedElements: [firstSourceClaim, "orbital prism"],
          explanation: `cross-candidate echo: ${firstSourceClaim}`,
        },
      ],
    });

    const analysisJson = repository.success[0].findings[0].analysisJson;
    expect(analysisJson).not.toContain(firstSourceClaim);
    expect(analysisJson).toContain("orbital prism");
    expect(analysisJson).toContain("人による確認が必要です");
  });

  it("chooses weighted-overall maximum and lower claim number on a tie", async () => {
    const repository = new FakeRunRepository(start(), batch([source(1)]));
    const tiedClaimTwo = {
      ...successfulAnalysis(1),
      draftClaimNo: 2,
      lexicalScore: 0.8,
      elementScore: 0.8,
      semanticScore: 0.8,
      structuralScore: 0.8,
      explanation: "claim two candidate",
    };
    const lowerOverall = {
      ...successfulAnalysis(1),
      draftClaimNo: 3,
      lexicalScore: 1,
      elementScore: 0,
      semanticScore: 0,
      structuralScore: 0,
      explanation: "lower overall candidate",
    };
    const tiedClaimOne = {
      ...tiedClaimTwo,
      draftClaimNo: 1,
      explanation: "claim one wins tie",
    };

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => ({
        relevantDocIds: [1],
        reasoning: "fictional screening",
      }),
      analyzeOverlap: async () => [
        tiedClaimTwo,
        lowerOverall,
        tiedClaimOne,
      ],
    });

    const finding = repository.success[0].findings[0];
    expect(finding.lexicalScore).toBe(0.8);
    expect(JSON.parse(finding.analysisJson)).toMatchObject({
      explanation: "claim one wins tie",
    });
  });

  it("ignores analysis results whose document ID was not selected", async () => {
    const repository = new FakeRunRepository(start(), batch([source(1)]));

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => ({
        relevantDocIds: [1],
        reasoning: "fictional screening",
      }),
      analyzeOverlap: async () => [successfulAnalysis(999_999)],
    });

    expect(repository.success[0].analysisMode).toBe("ai");
    expect(repository.success[0].findings).toEqual([]);
  });

  it.each(["screening", "analysis"] as const)(
    "uses deterministic fallback when %s fails",
    async (failurePoint) => {
      const documents = Array.from({ length: 25 }, (_, index) =>
        source(index + 1),
      );
      const repository = new FakeRunRepository(start(), batch(documents));

      await runPatentWatch(7, {
        repository,
        screenPriorArt: async (_claims, priorArts) => {
          if (failurePoint === "screening") {
            throw new Error("FICTIONAL-AI-SECRET-SENTINEL");
          }
          return {
            relevantDocIds: priorArts.map((item) => item.docId),
            reasoning: "fictional screening",
          };
        },
        analyzeOverlap: async () => {
          throw new Error("FICTIONAL-AI-SECRET-SENTINEL");
        },
      });

      const success = repository.success[0];
      expect(success.analysisMode).toBe("fallback");
      expect(success.findings).toHaveLength(20);
      expect(success.counts.fallbackFindingCount).toBe(20);
      expect(
        success.findings.every((item) => item.analysisMode === "fallback"),
      ).toBe(true);
      for (const finding of success.findings) {
        const analysis = JSON.parse(finding.analysisJson) as {
          explanation: string;
        };
        expect(analysis.explanation).toBe(PATENT_WATCH_FALLBACK_EXPLANATION);
      }
      expect(JSON.stringify(success)).not.toContain(
        "FICTIONAL-AI-SECRET-SENTINEL",
      );
    },
  );

  it("does not persist a short full claim as a fallback matched token", async () => {
    const shortClaims: ExtractedClaims = {
      ...CLAIMS,
      claims: [
        {
          claimNo: 1,
          text: "架空",
          isIndependent: true,
          dependsOn: null,
          elements: [],
        },
      ],
    };
    const repository = new FakeRunRepository(
      start({ extractedClaimsJson: JSON.stringify(shortClaims) }),
      batch([
        source(1, {
          inventionTitle: "架空",
          abstractText: null,
          claimsText: "架空",
        }),
      ]),
    );

    await runPatentWatch(7, {
      repository,
      screenPriorArt: async () => {
        throw new Error("FICTIONAL-SCREENING-FAILURE");
      },
      analyzeOverlap: async () => [],
    });

    const analysis = JSON.parse(
      repository.success[0].findings[0].analysisJson,
    ) as { matchedElements: string[]; explanation: string };
    expect(analysis.matchedElements).toEqual([]);
    expect(analysis.explanation).toBe(PATENT_WATCH_FALLBACK_EXPLANATION);
    expect(repository.success[0].findings[0].analysisJson).not.toContain(
      "架空",
    );
  });

  it("marks ordinary processing errors failed with a stable code only", async () => {
    const localPath = ["C:", "\\", "private\\file"].join("");
    const repository = new FakeRunRepository(
      start(),
      batch([]),
      [],
      new Error(`FICTIONAL-DB-ERROR ${localPath}`),
    );

    await expect(
      runPatentWatch(7, {
        repository,
        screenPriorArt: vi.fn(),
        analyzeOverlap: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "watch_internal_error" });
    expect(repository.success).toEqual([]);
    expect(repository.failure).toEqual([
      { caseId: 7, runId: 13, errorCode: "watch_internal_error" },
    ]);
    expect(JSON.stringify(repository.failure)).not.toContain("FICTIONAL-DB-ERROR");
  });

  it("does not treat a failed success-finalize as completed", async () => {
    const repository = new FakeRunRepository(start(), batch([source(1)]));
    repository.finalizeRunSuccess = async () => {
      throw new Error("FICTIONAL-FINALIZE-FAILURE");
    };

    await expect(
      runPatentWatch(7, {
        repository,
        screenPriorArt: async () => ({
          relevantDocIds: [1],
          reasoning: "fictional screening",
        }),
        analyzeOverlap: async () => [successfulAnalysis(1)],
      }),
    ).rejects.toMatchObject({ code: "watch_internal_error" });

    expect(repository.success).toEqual([]);
    expect(repository.failure).toEqual([
      { caseId: 7, runId: 13, errorCode: "watch_internal_error" },
    ]);
    expect(JSON.stringify(repository.failure)).not.toContain(
      "FICTIONAL-FINALIZE-FAILURE",
    );
  });
});
