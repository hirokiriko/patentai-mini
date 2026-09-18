import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { boundedAzureFetch } from "../ai-operation-budget";
import type { CaseWatchRun, PatentWatchRunRepository, PatentWatchRunSuccessInput } from "./types";
import { createPatentWatchCsvHandlers } from "./api";

const state = vi.hoisted(() => ({ repository: null as unknown as PatentWatchRunRepository }));
// Keep the real route/service/SDK/guard; replace only repository IO and provider setup.
vi.mock("@/repositories", () => ({ get patentWatchRepo() { return state.repository; } }));
vi.mock("@/lib/ai-operation-budget", () => import("../ai-operation-budget"));
vi.mock("@/lib/analyze-overlap", () => import("../analyze-overlap"));
vi.mock("@/lib/patent-watch/api", () => import("./api"));
vi.mock("@/lib/patent-watch/service", () => import("./service"));
vi.mock("../ai-model", () => ({
  getModel: () => createAzure({ baseURL: "https://example.invalid/openai", apiKey: "fictional",
    apiVersion: "v1", fetch: boundedAzureFetch("normal") })("fictional"),
  aiProviderRetries: () => 0,
  getGoogleThinkingProviderOptions: () => undefined,
}));
import { POST, maxDuration } from "../../app/api/cases/[caseId]/watch/runs/route";

const SECRET = "FICTIONAL_PRIVATE_DIAGNOSTIC_SENTINEL";
const at = "2096-03-20T00:00:00.000Z";
function fixture(count = 100, failFinalize = false) {
  const runs = new Map<number, CaseWatchRun>();
  const successes: PatentWatchRunSuccessInput[] = [];
  const failures: unknown[] = [];
  let cursor: string | null = null;
  const repository: PatentWatchRunRepository = {
    async startRun(caseId) {
      runs.set(caseId, { runId: caseId, watchId: caseId, status: "running", monitoringFromDate: "20960301",
        baseRunUpdatedAt: null, baseImportId: null, upperRunUpdatedAt: at, upperImportId: 1,
        startedAt: at, completedAt: null, scannedImportRunCount: 0, scannedDocumentCount: 0,
        prefilteredCount: 0, analyzedCount: 0, newFindingCount: 0, fallbackFindingCount: 0,
        analysisMode: "none", errorCode: null });
      return { caseId, watchId: caseId, runId: caseId, monitoringFromDate: "20960301",
        baseCursor: null, upperCursor: { runUpdatedAt: at, importId: 1 },
        extractedClaimsJson: JSON.stringify({ title: "fictional", abstract: SECRET, solvedProblems: [], effects: [],
          claims: [{ claimNo: 1, text: "orbital prism detector " + SECRET, isIndependent: true, dependsOn: null,
            elements: [{ type: "component", text: "orbital prism detector", importance: "core" }] }] }) };
    },
    async findDocumentsForRun() {
      return { scannedImportRunCount: 1, scannedDocumentCount: count,
        documents: Array.from({ length: count }, (_, i) => ({ documentId: i + 1, importId: 1,
          importRunUpdatedAt: at, publicationNumber: `JP2096-${i + 1}A`, publicationDate: "20960301",
          packageType: "JPA" as const, kind: "A1" as const, inventionTitle: "orbital prism detector",
          abstractText: "orbital prism detector ".repeat(30), claimsText: "fictional prism ".repeat(150),
          contentSha256: (i + 1).toString(16).padStart(64, "0") })) };
    },
    async findExistingSourceKeys() { return []; },
    async finalizeRunSuccess(input) {
      successes.push(input); cursor = at;
      const run = { ...runs.get(input.caseId)!, ...input.counts, status: "completed" as const,
        completedAt: at, analysisMode: input.analysisMode };
      runs.set(input.caseId, run); return run;
    },
    async finalizeRunFailure(input) {
      failures.push(input);
      if (failFinalize) throw new Error(SECRET);
      runs.set(input.caseId, { ...runs.get(input.caseId)!, status: "failed", completedAt: at, errorCode: input.errorCode });
    },
  };
  state.repository = repository;
  return { repository, runs, successes, failures, cursor: () => cursor };
}
function aiResponse(value: unknown, usage: unknown = { input_tokens: 100, output_tokens: 30 }) {
  return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
    diagnosticId: SECRET, output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }], usage,
  }, { headers: { "x-provider-secret": SECRET } });
}
const screen = { relevantDocIds: Array.from({ length: 20 }, (_, i) => i + 1), reasoning: "fictional" };
const detail = { results: [{ draftClaimNo: 1, priorDocId: 1, lexicalScore: 0.8, elementScore: 0.7,
  semanticScore: 0.6, structuralScore: 0.5, matchedElements: ["prism"], unmatchedElements: ["fictional constraint"],
  riskLabel: "Medium", explanation: "人による確認が必要です" }] };
function post(caseId = 7, body?: string) {
  return POST(new Request(`https://example.invalid/api/cases/${caseId}/watch/runs`, { method: "POST", body,
    headers: { "X-Patent-Watch-Diagnostic-Id": SECRET, cookie: SECRET } }), { params: Promise.resolve({ caseId: String(caseId) }) });
}
function events(name: string) {
  return vi.mocked(console.info).mock.calls.filter(call => call[0] === name).map(call => JSON.parse(String(call[1])));
}

describe("watch route through the installed SDK and guarded fake transport", () => {
  beforeEach(() => {
    for (const method of ["info", "warn", "error", "log"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const method of ["info", "warn", "error", "log"] as const) expect(JSON.stringify(vi.mocked(console[method]).mock.calls)).not.toContain(SECRET);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });
  it("keeps 100 screening / 20 detail inputs and one nested cumulative budget", async () => {
    const store = fixture();
    const payloads: string[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      payloads.push(String(init?.body));
      return aiResponse(payloads.length === 1 ? screen : detail);
    });
    vi.stubGlobal("fetch", transport);
    const response = await post();
    expect(maxDuration).toBe(120); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "completed", newFindingCount: 1, analysisMode: "ai" });
    expect(body).not.toHaveProperty("diagnostic");
    const payloadInputs = payloads.map(value => {
      const body = JSON.parse(value);
      expect(body.max_output_tokens).toBe(8192);
      return JSON.parse(body.input[1].content[0].text).priorArts;
    });
    expect(payloadInputs.map(items => items.length)).toEqual([100, 20]);
    expect(transport).toHaveBeenCalledTimes(2); expect(store.failures).toEqual([]);
    expect(events("ai_operation_usage").map(event => [event.attempt, event.stage, event.status])).toEqual([
      [1, "screening", "reconciled"], [2, "detail", "reconciled"],
    ]);
    const id = response.headers.get("X-Patent-Watch-Diagnostic-Id");
    expect(events("ai_operation_usage").every(event => event.diagnosticId === id)).toBe(true);
    expect(events("patent_watch_diagnostic")).toEqual([{ diagnosticId: id, code: "completed", stage: "unknown", reason: "unknown" }]);
  });
  it.each(["screening", "detail"] as const)("preserves %s HTTP refusal, failed state and CSV409", async stage => {
    const store = fixture();
    let sends = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => {
      if (++sends === 1 && stage === "detail") return aiResponse(screen);
      return new Response(SECRET, { status: 429, statusText: SECRET });
    }));
    const response = await post();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "watch_ai_stopped", diagnostic: {
      id: response.headers.get("X-Patent-Watch-Diagnostic-Id"), stage, reason: "upstream_http_error",
    } });
    expect(sends).toBe(stage === "detail" ? 2 : 1);
    expect(store.runs.get(7)?.status).toBe("failed"); expect(store.cursor()).toBeNull(); expect(store.successes).toEqual([]);
    const { GET } = createPatentWatchCsvHandlers({ repository: {
      getRun: async () => store.runs.get(7)!, listFindings: async () => [],
    } as unknown as Parameters<typeof createPatentWatchCsvHandlers>[0]["repository"] });
    const csv = await GET(new Request("https://example.invalid/watch/report.csv?runId=7"), { params: Promise.resolve({ caseId: "7" }) });
    expect(csv.status).toBe(409); expect(await csv.json()).toEqual({ error: "watch_report_not_completed" });
    expect(events("patent_watch_diagnostic")).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
  it("retains the reason even when failure finalization itself fails", async () => {
    const store = fixture(1, true);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error(SECRET)));
    const response = await post();
    expect(await response.json()).toMatchObject({ error: "watch_ai_stopped", diagnostic: { stage: "screening", reason: "transport_error" } });
    expect(store.failures).toHaveLength(1); expect(store.successes).toEqual([]); expect(store.cursor()).toBeNull();
    expect(store.runs.get(7)?.status).toBe("running");
  });
  it("keeps a valid-usage schema failure as the existing fallback", async () => {
    const store = fixture();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(aiResponse({ wrong: SECRET })));
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", analysisMode: "fallback", fallbackFindingCount: 20 });
    expect(store.failures).toEqual([]); expect(events("patent_watch_diagnostic")[0].reason).toBe("unknown");
  });
  it.each(["zero", "no-corpus"])("keeps the existing normal %s result", async scenario => {
    fixture(scenario === "no-corpus" ? 0 : 100);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(aiResponse({ relevantDocIds: [], reasoning: "fictional" }));
    vi.stubGlobal("fetch", transport);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ newFindingCount: 0, status: "completed" });
    expect(transport).toHaveBeenCalledTimes(scenario === "no-corpus" ? 0 : 1);
  });
  it("isolates concurrent routes even when transport resolves in the reverse order", async () => {
    fixture(1);
    const pending: Array<(value: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => pending.push(resolve))));
    const first = post(7), second = post(8);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1](new Response(SECRET, { status: 502 }));
    const secondResponse = await second;
    pending[0](aiResponse(screen, null));
    const firstResponse = await first;
    const a = await firstResponse.json(), b = await secondResponse.json();
    expect(a.diagnostic.id).not.toBe(b.diagnostic.id);
    expect(a.diagnostic).toMatchObject({ stage: "screening", reason: "usage_missing" });
    expect(b.diagnostic).toMatchObject({ stage: "screening", reason: "upstream_http_error" });
    expect(events("ai_operation_usage").map(event => [event.diagnosticId, event.attempt, event.reason])).toEqual([
      [b.diagnostic.id, 1, "upstream_http_error"], [a.diagnostic.id, 1, "usage_missing"],
    ]);
    expect(events("patent_watch_diagnostic")).toHaveLength(2);
  });
  it("puts a new ID on rejected POSTs without executing any AI", async () => {
    fixture(); const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
    const a = await post(7, SECRET), b = await post(7, "{}");
    expect(a.status).toBe(400); expect(await a.json()).toEqual({ error: "invalid_watch_run_request" });
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(a.headers.get("X-Patent-Watch-Diagnostic-Id")).not.toBe(b.headers.get("X-Patent-Watch-Diagnostic-Id"));
    expect(transport).not.toHaveBeenCalled(); expect(events("patent_watch_diagnostic")).toHaveLength(2);
  });
  it.each(["fetch", "body"])("keeps the actual outer deadline through SDK signal wrapping during %s", async phase => {
    fixture(1); vi.useFakeTimers();
    let deadlines = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      // The outer SDK deadline fires before the transport guard's deadline.
      setTimeout(() => controller.abort(new DOMException(SECRET, "TimeoutError")), ++deadlines === 1 ? ms - 1 : ms);
      return controller.signal;
    });
    const transport = vi.fn<typeof fetch>().mockImplementation(() => phase === "body"
      ? Promise.resolve({ ok: true, clone: () => ({ json: () => new Promise(() => {}) }) } as Response)
      : new Promise(() => {}));
    vi.stubGlobal("fetch", transport);
    const pending = post();
    await vi.advanceTimersByTimeAsync(34_999);
    const response = await pending;
    expect(await response.json()).toMatchObject({ error: "watch_ai_stopped", diagnostic: { stage: "screening", reason: "timeout" } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(events("ai_operation_usage").map(event => event.reason)).toEqual(["timeout"]);
  });
});
