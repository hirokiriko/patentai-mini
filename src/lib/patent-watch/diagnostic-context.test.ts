import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPatentWatchRunHandlers } from "./api";
import { PatentWatchDomainError } from "./domain";
import { AiOperationBudget, boundedAzureFetch, withAiOperationBudget } from "../ai-operation-budget";
import { currentPatentWatchDiagnostic, withPatentWatchDiagnostic, withPatentWatchStage } from "./diagnostic-context";
import { parsePatentWatchDiagnostic } from "./diagnostic";

vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
afterEach(() => vi.restoreAllMocks());
describe("optional watch diagnostic context", () => {
  it("omits diagnostics when UUID generation fails and executes the business operation once", async () => {
    vi.mocked(randomUUID).mockImplementationOnce(() => { throw new Error("FICTIONAL_SECRET"); });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const executeRun = vi.fn(async () => { throw new PatentWatchDomainError("watch_ai_stopped"); });
    const { POST } = createPatentWatchRunHandlers({ executeRun });
    const result = await POST(new Request("https://example.invalid/watch/runs", { method: "POST" }), { params: Promise.resolve({ caseId: "7" }) });
    expect(result.status).toBe(500); expect(await result.json()).toEqual({ error: "watch_ai_stopped" });
    expect(result.headers.get("X-Patent-Watch-Diagnostic-Id")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(executeRun).toHaveBeenCalledTimes(1); expect(info).not.toHaveBeenCalled();
  });
  it("closes a returned stage before the same request starts another stage", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transport = vi.fn<typeof fetch>();
    let late!: () => Promise<Response>;
    await withPatentWatchDiagnostic(async () => {
      await withPatentWatchStage("screening", async () => {
        const guarded = new AiOperationBudget({ normal: 1, fast: 0 }).wrapFetch("normal", transport);
        late = () => guarded("https://example.invalid/responses", {});
      });
      await withPatentWatchStage("detail", async () => {
        await expect(late()).rejects.toMatchObject({ reason: "unknown" });
        expect(currentPatentWatchDiagnostic()).toMatchObject({ stage: "unknown", reason: "unknown" });
      });
      return { response: new Response(), code: "completed" };
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects diagnostic accessors and symbol fields without reading their values", () => {
    const getter = vi.fn(() => "FICTIONAL_SECRET");
    const data = { id: "d01e5145-dc6c-4ca3-839b-62bb20b32e84", stage: "detail", reason: "input_limit" };
    expect(parsePatentWatchDiagnostic(Object.defineProperty({ ...data }, "id", { get: getter }))).toBeNull();
    expect(parsePatentWatchDiagnostic({ ...data, [Symbol("hidden")]: "FICTIONAL_SECRET" })).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([false, true])("does not let an expired stage poison a live budget (malformed headers: %s)", async malformedHeaders => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    vi.stubGlobal("fetch", transport);
    const input = { method: "POST", body: JSON.stringify({ model: "fictional", input: [],
      max_output_tokens: 8192, text: { format: { type: "json_schema", schema: {} } } }) };
    const url = "https://example.invalid/responses";
    let late!: () => Promise<Response>;
    try {
      await withPatentWatchDiagnostic(async () => withAiOperationBudget({ normal: 2, fast: 0 }, async () => {
        await withPatentWatchStage("screening", async () => {
          const guard = boundedAzureFetch("normal"); late = () => guard(url, malformedHeaders ? { ...input, headers: { "x-fictional": "bad\nheader" } } : input);
          await guard(url, input);
        });
        await withPatentWatchStage("detail", async () => {
          await expect(late()).rejects.toMatchObject({ reason: "unknown" });
          await expect(boundedAzureFetch("normal")(url, input)).resolves.toBeInstanceOf(Response);
          expect(currentPatentWatchDiagnostic()).toMatchObject({ reason: "unknown", stage: "unknown" });
        });
        return { response: new Response(), code: "completed" };
      }));
      expect(transport).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });
});
