import { afterEach, describe, expect, it, vi } from "vitest";
import { AiOperationBudget } from "../ai-operation-budget";
import { capturePatentWatchDiagnostic, currentPatentWatchDiagnosticObservation, observePatentWatchDetail, withPatentWatchDiagnostic, withPatentWatchStage } from "./diagnostic-context";
import { createDetailObservation, parsePatentWatchDiagnosticObservation } from "./diagnostic-observation";

const id = "d01e5145-dc6c-4ca3-839b-62bb20b32e84";
const diagnostic = { id, stage: "detail" as const, reason: "timeout" as const };
const sample = { id, stage: "detail", phase: "before_dispatch", candidateCount: 20, independentClaimCount: 1,
  requestBytes: null, attempt: null, stageElapsedMs: 0, requestElapsedMs: null, phaseElapsedMs: 0 };
const request = { method: "POST", body: JSON.stringify({ model: "fictional", input: [], max_output_tokens: 8192,
  text: { format: { type: "json_schema", schema: {} } } }) };
afterEach(() => vi.restoreAllMocks());
describe("optional detail observation", () => {
  it("rejects accessors, additional keys, unknown enums and invalid numbers without calling getters", () => {
    const getter = vi.fn(() => "FICTIONAL_PRIVATE_SENTINEL");
    for (const value of [null, [], { ...sample, secret: "FICTIONAL_PRIVATE_SENTINEL" }, { ...sample, [Symbol()]: 1 },
      { ...sample, phase: "<html>" }, { ...sample, id: id.replace("d01", "d02") }, { ...sample, stage: "screening" },
      ...[-1, 0.5, Infinity, NaN, "secret", undefined].map(attempt => ({ ...sample, attempt })),
      Object.defineProperty({ ...sample }, "phase", { get: getter })]) {
      expect(parsePatentWatchDiagnosticObservation(value, diagnostic)).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(parsePatentWatchDiagnosticObservation(sample, diagnostic)).toEqual(sample);
  });
  it("keeps three clocks and never replaces an unavailable clock with zero", () => {
    let now = 12.9; vi.spyOn(performance, "now").mockImplementation(() => now);
    const observation = createDetailObservation(id, 10, 20, 1, () => true);
    expect(observation.snapshot()).toMatchObject({ stageElapsedMs: 2, requestElapsedMs: null, phaseElapsedMs: 0 });
    now = 20; observation.dispatch(2); now = 24; observation.phase("reading_response"); now = 31.5;
    expect(observation.freeze()).toMatchObject({ stageElapsedMs: 21, requestElapsedMs: 11, phaseElapsedMs: 7 });
    now = 900; observation.phase("response_validated"); observation.bytes(999);
    expect(observation.snapshot()).toMatchObject({ phase: "reading_response", phaseElapsedMs: 7, requestBytes: null });
    vi.mocked(performance.now).mockImplementation(() => { throw Error("FICTIONAL_PRIVATE_SENTINEL"); });
    expect(createDetailObservation(id, null, 1, 1, () => true).snapshot()).toMatchObject({ stageElapsedMs: null, phaseElapsedMs: null, requestElapsedMs: null });
  });
  it("preabort keeps unobserved request fields null and sends nothing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transport = vi.fn<typeof fetch>(), controller = new AbortController(); controller.abort();
    await withPatentWatchDiagnostic(async () => {
      await withPatentWatchStage("detail", async () => {
        observePatentWatchDetail(3, 2);
        await expect(new AiOperationBudget({ normal: 1, fast: 0 }).wrapFetch("normal", transport)("https://example.invalid/responses", { ...request, signal: controller.signal })).rejects.toMatchObject({ reason: "aborted" });
      });
      expect(currentPatentWatchDiagnosticObservation()).toMatchObject({ phase: "before_dispatch", candidateCount: 3, independentClaimCount: 2, requestBytes: null, attempt: null, requestElapsedMs: null });
      return { response: new Response(), code: "watch_ai_stopped" };
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("isolates concurrent attempts and freezes the first stopped attempt across later stages", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pending: ((response: Response) => void)[] = [];
    await withPatentWatchDiagnostic(async () => {
      await withPatentWatchStage("detail", async () => {
        observePatentWatchDetail(2, 1);
        const guard = new AiOperationBudget({ normal: 2, fast: 0 }).wrapFetch("normal", () => new Promise(resolve => pending.push(resolve)));
        const first = guard("https://example.invalid/responses", request).catch(error => error);
        const second = guard("https://example.invalid/responses", request).catch(error => error);
        pending[1](new Response("fictional", { status: 503 })); await second;
        const snapshot = currentPatentWatchDiagnosticObservation(); expect(snapshot?.attempt).toBe(2);
        pending[0](Response.json({ usage: null })); await first;
        expect(currentPatentWatchDiagnosticObservation()).toEqual(snapshot);
      });
      const snapshot = currentPatentWatchDiagnosticObservation();
      await withPatentWatchStage("screening", async () => capturePatentWatchDiagnostic()?.stop("transport_error"));
      expect(currentPatentWatchDiagnosticObservation()).toEqual(snapshot);
      return { response: new Response(), code: "watch_ai_stopped" };
    });
    expect(currentPatentWatchDiagnosticObservation()).toBeNull();
  });
  it("clock and logger faults leave successful transport and usage unchanged", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw Error("FICTIONAL_PRIVATE_SENTINEL"); });
    vi.spyOn(performance, "now").mockImplementation(() => { throw Error("FICTIONAL_PRIVATE_SENTINEL"); });
    await withPatentWatchDiagnostic(async () => {
      await withPatentWatchStage("detail", async () => {
        observePatentWatchDetail(2, 1);
        const budget = new AiOperationBudget({ normal: 1, fast: 0 });
        const response = await budget.wrapFetch("normal", async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }))("https://example.invalid/responses", request);
        expect(response.status).toBe(200); expect(budget.used.normal).toBe(1);
      });
      return { response: new Response(), code: "completed" };
    });
  });
  it("resets attempt clocks while preserving stage time and removes each abort listener", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    let now = 10; vi.spyOn(performance, "now").mockImplementation(() => now);
    const removals: ReturnType<typeof vi.spyOn>[] = [];
    await withPatentWatchDiagnostic(async () => {
      await withPatentWatchStage("detail", async () => {
        observePatentWatchDetail(1, 1);
        const guard = new AiOperationBudget({ normal: 2, fast: 0 }).wrapFetch("normal", async (_url, init) => {
          removals.push(vi.spyOn(init!.signal!, "removeEventListener")); now += 5;
          return Response.json({ usage: removals.length === 1 ? { input_tokens: 1, output_tokens: 1 } : null });
        });
        await guard("https://example.invalid/responses", request); now = 100;
        await expect(guard("https://example.invalid/responses", request)).rejects.toMatchObject({ reason: "usage_missing" });
        expect(currentPatentWatchDiagnosticObservation()).toMatchObject({ attempt: 2, stageElapsedMs: 95, requestElapsedMs: 5, phaseElapsedMs: 0 });
      });
      return { response: new Response(), code: "watch_ai_stopped" };
    });
    expect(removals).toHaveLength(2);
    for (const remove of removals) expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
