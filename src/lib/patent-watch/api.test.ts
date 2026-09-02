import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createPatentWatchCsvHandlers,
  createPatentWatchFindingHandlers,
  createPatentWatchHandlers,
  createPatentWatchRunHandlers,
  type PatentWatchApiRepository,
} from "./api";
import { PatentWatchDomainError } from "./domain";
import type {
  CaseWatchFinding,
  CaseWatchRun,
  CaseWatchSetting,
} from "./types";

const PRIVATE_HASH = "a".repeat(64);
const PRIVATE_LOCAL_PATH = ["C:", "\\", "private\\fictional.xml"].join("");
const PRIVATE_SIGNED_URL_SECRET = "FICTIONAL_SAS_SIGNATURE";
const PRIVATE_SESSION_SECRET = "FICTIONAL_SESSION_SECRET";
const PRIVATE_SIGNED_URL = [
  "https",
  "://",
  "fictional.blob.core.windows.net/private?sv=2099-01-01&sig=",
  PRIVATE_SIGNED_URL_SECRET,
].join("");
const API_SOURCE_URL = new URL("./api.ts", import.meta.url);

function setting(
  overrides: Partial<CaseWatchSetting> = {},
): CaseWatchSetting {
  return {
    watchId: 11,
    caseId: 7,
    enabled: true,
    monitoringFromDate: "20960229",
    cursorRunUpdatedAt: "2096-03-01T00:00:00.000Z",
    cursorImportId: 41,
    createdAt: "2096-02-01T00:00:00.000Z",
    updatedAt: "2096-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<CaseWatchRun> = {}): CaseWatchRun {
  return {
    runId: 21,
    watchId: 11,
    status: "completed",
    monitoringFromDate: "20960229",
    baseRunUpdatedAt: "2096-03-01T00:00:00.000Z",
    baseImportId: 41,
    upperRunUpdatedAt: "2096-03-02T00:00:00.000Z",
    upperImportId: 42,
    startedAt: "2096-03-02T01:00:00.000Z",
    completedAt: "2096-03-02T01:00:01.000Z",
    scannedImportRunCount: 1,
    scannedDocumentCount: 2,
    prefilteredCount: 1,
    analyzedCount: 1,
    newFindingCount: 1,
    fallbackFindingCount: 0,
    analysisMode: "ai",
    errorCode: null,
    ...overrides,
  };
}

function finding(
  overrides: Partial<CaseWatchFinding> = {},
): CaseWatchFinding {
  return {
    findingId: 31,
    watchId: 11,
    firstRunId: 21,
    sourceKey: PRIVATE_HASH,
    corpusDocumentId: 99,
    packageType: "JPA",
    kind: "A1",
    publicationNumber: "JP2096-000001A",
    publicationDate: "20960301",
    inventionTitle: "完全に架空の軌道プリズム",
    abstractPreview: "完全に架空の要約",
    lexicalScore: 0.9,
    elementScore: 0.8,
    semanticScore: 0.7,
    structuralScore: 0.6,
    riskLabel: "Medium",
    analysisJson: JSON.stringify({
      matchedElements: ["軌道プリズム"],
      unmatchedElements: ["架空の制約"],
      explanation: "重なり候補です。人による確認が必要です",
    }),
    analysisMode: "ai",
    reviewStatus: "unreviewed",
    firstSeenAt: "2096-03-02T01:00:01.000Z",
    ...overrides,
  };
}

class FakePatentWatchRepository implements PatentWatchApiRepository {
  settingResult: CaseWatchSetting | null = setting();
  runsResult: CaseWatchRun[] = [run()];
  findingsResult: CaseWatchFinding[] = [finding()];
  runResult: CaseWatchRun | null = run();
  unreviewedCount = 1;
  error: unknown;

  readonly getSettingCalls: number[] = [];
  readonly upsertSettingCalls: Array<{
    caseId: number;
    data: { enabled: boolean; monitoringFromDate: string };
  }> = [];
  readonly getRunCalls: Array<{ caseId: number; runId: number }> = [];
  readonly listRunsCalls: Array<{ caseId: number; limit: number }> = [];
  readonly listFindingsCalls: Array<{
    caseId: number;
    options: { runId?: number; limit: number };
  }> = [];
  readonly countCalls: number[] = [];
  readonly updateCalls: Array<{
    caseId: number;
    findingId: number;
    reviewStatus: "reviewed" | "unreviewed";
  }> = [];

  private fail(): void {
    if (this.error !== undefined) throw this.error;
  }

  async getSetting(caseId: number) {
    this.getSettingCalls.push(caseId);
    this.fail();
    return this.settingResult;
  }

  async upsertSetting(
    caseId: number,
    data: { enabled: boolean; monitoringFromDate: string },
  ) {
    this.upsertSettingCalls.push({ caseId, data: { ...data } });
    this.fail();
    return { ...setting(), ...data };
  }

  async getRun(caseId: number, runId: number) {
    this.getRunCalls.push({ caseId, runId });
    this.fail();
    return this.runResult;
  }

  async listRuns(caseId: number, limit: number) {
    this.listRunsCalls.push({ caseId, limit });
    this.fail();
    return this.runsResult;
  }

  async listFindings(
    caseId: number,
    options: { runId?: number; limit: number },
  ) {
    this.listFindingsCalls.push({ caseId, options: { ...options } });
    this.fail();
    return this.findingsResult;
  }

  async countUnreviewedFindings(caseId: number) {
    this.countCalls.push(caseId);
    this.fail();
    return this.unreviewedCount;
  }

  async updateFindingReviewStatus(
    caseId: number,
    findingId: number,
    reviewStatus: "reviewed" | "unreviewed",
  ) {
    this.updateCalls.push({ caseId, findingId, reviewStatus });
    this.fail();
    return this.findingsResult[0]
      ? { ...this.findingsResult[0], reviewStatus }
      : null;
  }
}

function caseContext(caseId = "7") {
  return { params: Promise.resolve({ caseId }) };
}

function findingContext(caseId = "7", findingId = "31") {
  return { params: Promise.resolve({ caseId, findingId }) };
}

function watchRequest(method = "GET", body?: string) {
  return new Request("http://localhost/api/cases/7/watch", {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("patent watch GET/PUT handlers", () => {
  it("returns bounded public status, history, and findings only", async () => {
    const repository = new FakePatentWatchRepository();
    repository.findingsResult = [
      {
        ...finding({
          inventionTitle: `架空 ${PRIVATE_HASH}`,
          analysisJson: JSON.stringify({
            matchedElements: [
              `軌道プリズム ${PRIVATE_SIGNED_URL}`,
              `Cookie: session=${PRIVATE_SESSION_SECRET}`,
            ],
            unmatchedElements: [
              `{"sessionToken":"${PRIVATE_SESSION_SECRET}"}`,
            ],
            explanation: `${PRIVATE_LOCAL_PATH} の重なり候補です`,
            rawAi: "FICTIONAL-RAW-AI-LEAK",
          }),
        }),
        rawXml: "FICTIONAL-RAW-XML-LEAK",
        claimsText: "FICTIONAL-FULL-CLAIMS-LEAK",
        normalizedEntryPath: "FICTIONAL-PATH-LEAK",
      } as CaseWatchFinding,
    ];
    const { GET } = createPatentWatchHandlers({ repository });

    const response = await GET(watchRequest(), caseContext());
    const body = await jsonBody(response);

    expect(response.status).toBe(200);
    expect(repository.listRunsCalls).toEqual([{ caseId: 7, limit: 20 }]);
    expect(repository.listFindingsCalls).toEqual([
      { caseId: 7, options: { limit: 100 } },
    ]);
    expect(repository.countCalls).toEqual([7]);
    expect(Object.keys(body)).toEqual([
      "setting",
      "latestRun",
      "unreviewedFindingCount",
      "runs",
      "findings",
    ]);
    expect(body.setting).toEqual({
      watchId: 11,
      enabled: true,
      monitoringFromDate: "20960229",
      createdAt: "2096-02-01T00:00:00.000Z",
      updatedAt: "2096-03-01T00:00:00.000Z",
    });
    const publicFinding = (body.findings as Array<Record<string, unknown>>)[0];
    expect(Object.keys(publicFinding)).toEqual([
      "findingId",
      "firstRunId",
      "packageType",
      "kind",
      "publicationNumber",
      "publicationDate",
      "inventionTitle",
      "abstractPreview",
      "lexicalScore",
      "elementScore",
      "semanticScore",
      "structuralScore",
      "riskLabel",
      "matchedElements",
      "unmatchedElements",
      "explanation",
      "analysisMode",
      "reviewStatus",
      "firstSeenAt",
    ]);
    const text = JSON.stringify(body);
    for (const forbidden of [
      PRIVATE_HASH,
      PRIVATE_LOCAL_PATH,
      PRIVATE_SIGNED_URL_SECRET,
      PRIVATE_SESSION_SECRET,
      "FICTIONAL-RAW-AI-LEAK",
      "FICTIONAL-RAW-XML-LEAK",
      "FICTIONAL-FULL-CLAIMS-LEAK",
      "FICTIONAL-PATH-LEAK",
      "sourceKey",
      "corpusDocumentId",
      "cursorImportId",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("returns an empty summary for an existing case without a setting", async () => {
    const repository = new FakePatentWatchRepository();
    repository.settingResult = null;
    const { GET } = createPatentWatchHandlers({ repository });

    const response = await GET(watchRequest(), caseContext());

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      setting: null,
      latestRun: null,
      unreviewedFindingCount: 0,
      runs: [],
      findings: [],
    });
    expect(repository.listRunsCalls).toEqual([]);
    expect(repository.listFindingsCalls).toEqual([]);
  });

  it.each(["", "0", "+1", "1.5", "01", "2147483648", "not-id"])(
    "rejects invalid case id %s without repository access",
    async (caseId) => {
      const repository = new FakePatentWatchRepository();
      const { GET } = createPatentWatchHandlers({ repository });

      const response = await GET(watchRequest(), caseContext(caseId));

      expect(response.status).toBe(404);
      expect(await jsonBody(response)).toEqual({ error: "case_not_found" });
      expect(repository.getSettingCalls).toEqual([]);
    },
  );

  it("fails closed on a partial persisted cursor", async () => {
    const repository = new FakePatentWatchRepository();
    repository.settingResult = setting({ cursorImportId: null });
    const { GET } = createPatentWatchHandlers({ repository });

    const response = await GET(watchRequest(), caseContext());

    expect(response.status).toBe(503);
    expect(await jsonBody(response)).toEqual({ error: "watch_unavailable" });
  });

  it("accepts the exact setting body and returns only the saved setting", async () => {
    const repository = new FakePatentWatchRepository();
    const { PUT } = createPatentWatchHandlers({ repository });
    const request = jsonRequest(
      "http://localhost/api/cases/7/watch",
      "PUT",
      { enabled: false, monitoringFromDate: "20960229" },
    );

    const response = await PUT(request, caseContext());

    expect(response.status).toBe(200);
    expect(repository.upsertSettingCalls).toEqual([
      {
        caseId: 7,
        data: { enabled: false, monitoringFromDate: "20960229" },
      },
    ]);
    expect(await jsonBody(response)).toEqual({
      watchId: 11,
      enabled: false,
      monitoringFromDate: "20960229",
      createdAt: "2096-02-01T00:00:00.000Z",
      updatedAt: "2096-03-01T00:00:00.000Z",
    });
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["missing key", JSON.stringify({ enabled: true })],
    [
      "extra key",
      JSON.stringify({
        enabled: true,
        monitoringFromDate: "20960229",
        extra: true,
      }),
    ],
    [
      "invalid leap day",
      JSON.stringify({ enabled: true, monitoringFromDate: "20950229" }),
    ],
  ])("rejects %s as invalid_watch_setting", async (_name, body) => {
    const repository = new FakePatentWatchRepository();
    const { PUT } = createPatentWatchHandlers({ repository });

    const response = await PUT(
      watchRequest("PUT", body),
      caseContext(),
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({
      error: "invalid_watch_setting",
    });
    expect(repository.upsertSettingCalls).toEqual([]);
  });

  it.each([
    ["case_not_found", 404],
    ["watch_unavailable", 503],
  ] as const)("maps %s without exposing repository detail", async (code, status) => {
    const repository = new FakePatentWatchRepository();
    repository.error = new PatentWatchDomainError(code);
    const { GET } = createPatentWatchHandlers({ repository });

    const response = await GET(watchRequest(), caseContext());

    expect(response.status).toBe(status);
    expect(await jsonBody(response)).toEqual({ error: code });
  });

  it("sanitizes unexpected repository errors", async () => {
    const repository = new FakePatentWatchRepository();
    repository.error = new Error(
      `FICTIONAL-DB-ERROR claims=SECRET path=${PRIVATE_LOCAL_PATH} hash=${PRIVATE_HASH}`,
    );
    const { GET } = createPatentWatchHandlers({ repository });

    const response = await GET(watchRequest(), caseContext());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe(JSON.stringify({ error: "watch_internal_error" }));
    expect(text).not.toContain("FICTIONAL-DB-ERROR");
    expect(text).not.toContain("SECRET");
  });
});

describe("patent watch POST run handler", () => {
  it("rejects a non-empty stream without buffering the full request", async () => {
    const source = await readFile(API_SOURCE_URL, "utf8");

    expect(source).toContain("request.body.getReader()");
    expect(source).toContain("const firstChunk = await reader.read()");
    expect(source).not.toContain("request.arrayBuffer()");
  });

  it.each([
    ["no body", undefined],
    ["zero-byte body", ""],
  ])("accepts %s and returns a public run", async (_name, body) => {
    const executeRun = vi.fn(async () => run());
    const { POST } = createPatentWatchRunHandlers({ executeRun });

    const response = await POST(
      watchRequest("POST", body),
      caseContext(),
    );

    expect(response.status).toBe(200);
    expect(executeRun).toHaveBeenCalledWith(7);
    const payload = await jsonBody(response);
    expect(payload).toMatchObject({
      runId: 21,
      status: "completed",
      newFindingCount: 1,
      analysisMode: "ai",
    });
    expect(payload).not.toHaveProperty("watchId");
    expect(payload).not.toHaveProperty("monitoringFromDate");
    expect(payload).not.toHaveProperty("baseRunUpdatedAt");
    expect(payload).not.toHaveProperty("upperImportId");
  });

  it.each([" ", "{}", "null", "\n"])(
    "rejects non-zero-byte body %#",
    async (body) => {
      const executeRun = vi.fn(async () => run());
      const { POST } = createPatentWatchRunHandlers({ executeRun });

      const response = await POST(
        watchRequest("POST", body),
        caseContext(),
      );

      expect(response.status).toBe(400);
      expect(await jsonBody(response)).toEqual({
        error: "invalid_watch_run_request",
      });
      expect(executeRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["watch_not_configured", 409],
    ["watch_disabled", 409],
    ["watch_claims_not_ready", 409],
    ["watch_run_in_progress", 409],
    ["watch_corpus_unavailable", 503],
  ] as const)("maps run error %s", async (code, status) => {
    const executeRun = vi.fn(async () => {
      throw new PatentWatchDomainError(code);
    });
    const { POST } = createPatentWatchRunHandlers({ executeRun });

    const response = await POST(watchRequest("POST"), caseContext());

    expect(response.status).toBe(status);
    expect(await jsonBody(response)).toEqual({ error: code });
  });
});

describe("patent watch PATCH finding handler", () => {
  it.each(["reviewed", "unreviewed"] as const)(
    "updates %s within the case boundary",
    async (reviewStatus) => {
      const repository = new FakePatentWatchRepository();
      const { PATCH } = createPatentWatchFindingHandlers({ repository });
      const request = jsonRequest(
        "http://localhost/api/cases/7/watch/findings/31",
        "PATCH",
        { reviewStatus },
      );

      const response = await PATCH(request, findingContext());

      expect(response.status).toBe(200);
      expect(repository.updateCalls).toEqual([
        { caseId: 7, findingId: 31, reviewStatus },
      ]);
      const payload = await jsonBody(response);
      expect(payload).toMatchObject({ findingId: 31, reviewStatus });
      expect(payload).not.toHaveProperty("sourceKey");
    },
  );

  it.each([
    ["malformed", "{not-json"],
    ["missing", "{}"],
    ["unknown", JSON.stringify({ reviewStatus: "pending" })],
    [
      "extra",
      JSON.stringify({ reviewStatus: "reviewed", extra: true }),
    ],
  ])("rejects %s review body", async (_name, body) => {
    const repository = new FakePatentWatchRepository();
    const { PATCH } = createPatentWatchFindingHandlers({ repository });

    const response = await PATCH(
      new Request(
        "http://localhost/api/cases/7/watch/findings/31",
        { method: "PATCH", body },
      ),
      findingContext(),
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({
      error: "invalid_watch_review_status",
    });
    expect(repository.updateCalls).toEqual([]);
  });

  it.each([
    ["bad case", "0", "31", "case_not_found"],
    ["bad finding", "7", "0", "watch_finding_not_found"],
    ["leading zero finding", "7", "031", "watch_finding_not_found"],
    ["overflow finding", "7", "2147483648", "watch_finding_not_found"],
  ])(
    "rejects %s before repository access",
    async (_name, caseId, findingId, code) => {
      const repository = new FakePatentWatchRepository();
      const { PATCH } = createPatentWatchFindingHandlers({ repository });
      const request = jsonRequest(
        "http://localhost/api/cases/7/watch/findings/31",
        "PATCH",
        { reviewStatus: "reviewed" },
      );

      const response = await PATCH(
        request,
        findingContext(caseId, findingId),
      );

      expect(response.status).toBe(404);
      expect(await jsonBody(response)).toEqual({ error: code });
      expect(repository.updateCalls).toEqual([]);
    },
  );

  it("returns watch_finding_not_found when no row belongs to the case", async () => {
    const repository = new FakePatentWatchRepository();
    repository.findingsResult = [];
    const { PATCH } = createPatentWatchFindingHandlers({ repository });
    const request = jsonRequest(
      "http://localhost/api/cases/7/watch/findings/31",
      "PATCH",
      { reviewStatus: "reviewed" },
    );

    const response = await PATCH(request, findingContext());

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({
      error: "watch_finding_not_found",
    });
  });
});

describe("patent watch CSV handler", () => {
  function csvRequest(query = "?runId=21") {
    return new Request(
      `http://localhost/api/cases/7/watch/report.csv${query}`,
    );
  }

  it("checks run ownership and returns only the exact safe CSV", async () => {
    const repository = new FakePatentWatchRepository();
    repository.findingsResult = [finding()];
    const { GET } = createPatentWatchCsvHandlers({ repository });

    const response = await GET(csvRequest(), caseContext());
    const bytes = new Uint8Array(await response.arrayBuffer());
    const csv = new TextDecoder().decode(bytes);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="patent-watch-case-7-run-21.csv"',
    );
    expect(repository.getRunCalls).toEqual([{ caseId: 7, runId: 21 }]);
    expect(repository.listFindingsCalls).toEqual([
      { caseId: 7, options: { runId: 21, limit: 100 } },
    ]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv).toContain("公開番号,公開日,kind,発明名称");
    expect(csv).not.toContain(PRIVATE_HASH);
    expect(csv).not.toContain("sourceKey");
  });

  it.each([
    ["missing", ""],
    ["empty", "?runId="],
    ["zero", "?runId=0"],
    ["leading zero", "?runId=021"],
    ["fraction", "?runId=1.5"],
    ["overflow", "?runId=2147483648"],
    ["duplicate", "?runId=21&runId=22"],
    ["extra", "?runId=21&extra=1"],
  ])("rejects %s query as run not found", async (_name, query) => {
    const repository = new FakePatentWatchRepository();
    const { GET } = createPatentWatchCsvHandlers({ repository });

    const response = await GET(csvRequest(query), caseContext());

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "watch_run_not_found" });
    expect(repository.getRunCalls).toEqual([]);
  });

  it("returns not found without listing findings for another case's run", async () => {
    const repository = new FakePatentWatchRepository();
    repository.runResult = null;
    const { GET } = createPatentWatchCsvHandlers({ repository });

    const response = await GET(csvRequest(), caseContext());

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "watch_run_not_found" });
    expect(repository.listFindingsCalls).toEqual([]);
  });
});

describe("patent watch thin route contract", () => {
  it("keeps the synchronous run route finite and body-free", async () => {
    const source = await readFile(
      new URL(
        "../../app/api/cases/[caseId]/watch/runs/route.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('export const runtime = "nodejs"');
    expect(source).toContain("export const maxDuration = 120");
    expect(source).toContain("screenPriorArt");
    expect(source).toContain("analyzeOverlap");
    expect(source).toContain("runPatentWatch");
    expect(source).not.toContain("NextResponse");
    expect(source).not.toContain("request.json");
  });
});
