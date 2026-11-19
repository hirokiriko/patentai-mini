import { afterEach, expect, it, vi } from "vitest";
import { AiOperationBudget } from "./ai-operation-budget";
import { captureAiRequestTiming, withAiRequestTiming, type AiRequestTimingEvent } from "./ai-request-timing";
import { comparisonObservation } from "./prior-art-comparison/observation";

afterEach(() => vi.restoreAllMocks());
const init = { method: "POST", body: JSON.stringify({ model: "fictional", input: [{ role: "user", content: "PRIVATE_SENTINEL" }], max_output_tokens: 8192, text: { format: { type: "json_schema", schema: { type: "object" } } } }) };

it.each([400, 429, 500])("records only HTTP status %s without reading an error body or retrying", async status => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {}), events: AiRequestTimingEvent[] = [];
  const body = vi.fn(() => { throw Error("PRIVATE_SENTINEL"); });
  const response = { ok: false, status, statusText: "PRIVATE_SENTINEL", clone: body, json: body, text: body } as unknown as Response;
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response), budget = new AiOperationBudget({ normal: 2, fast: 2 });
  const observation = comparisonObservation("12345678-1234-4234-8234-123456789abc");
  await withAiRequestTiming(event => { events.push(event); observation.emit("request_timing", { timing: event }); }, async () => {
    await expect(budget.wrapFetch("normal", transport)("https://fixture.invalid/responses", init)).rejects.toMatchObject({ reason: "upstream_http_error" });
    await expect(budget.wrapFetch("fast", transport)("https://fixture.invalid/responses", init)).rejects.toMatchObject({ reason: "upstream_http_error" });
  });
  expect(events.find(event => event.phase === "headers_received")).toMatchObject({ httpStatus: status });
  expect(events.filter(event => event.phase !== "headers_received").every(event => event.httpStatus === undefined)).toBe(true);
  const rows = log.mock.calls.filter(row => row[0] === "prior_art_comparison_diagnostic").map(row => JSON.parse(String(row[1])));
  expect(rows.find(row => row.phase === "headers_received").httpStatus).toBe(status);
  expect(body).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledOnce();
  expect(budget.used).toEqual({ normal: 1, fast: 0 });
  expect(JSON.stringify({ events, rows })).not.toContain("PRIVATE_SENTINEL");
});

it.each([undefined, NaN, 99, 600, 400.5])("omits malformed status %s and status outside the headers phase", async status => {
  const events: AiRequestTimingEvent[] = [];
  await withAiRequestTiming(event => events.push(event), async () => {
    const trace = captureAiRequestTiming()!(1);
    trace.emit("headers_received", status); trace.emit("body_begin", 401); trace.close();
  });
  expect(events.every(event => event.httpStatus === undefined)).toBe(true);
});

it("does not change the HTTP stop when optional status observation throws", async () => {
  const events: AiRequestTimingEvent[] = [], getter = vi.fn(() => { throw Error("PRIVATE_SENTINEL"); });
  const response = Object.defineProperty({ ok: false }, "status", { get: getter }) as Response;
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response), budget = new AiOperationBudget({ normal: 1, fast: 0 });
  await withAiRequestTiming(event => events.push(event), async () => {
    await expect(budget.wrapFetch("normal", transport)("https://fixture.invalid/responses", init)).rejects.toMatchObject({ reason: "upstream_http_error" });
  });
  expect(getter).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
  expect(events.find(event => event.phase === "headers_received")?.httpStatus).toBeUndefined();
  expect(events.find(event => event.phase === "stopped")?.stopReason).toBe("upstream_http_error");
  expect(budget.used).toEqual({ normal: 1, fast: 0 });
});

it("keeps a successful response and reconciled usage unchanged", async () => {
  const events: AiRequestTimingEvent[] = [], response = Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response), budget = new AiOperationBudget({ normal: 1, fast: 0 });
  await withAiRequestTiming(event => events.push(event), async () => {
    expect(await budget.wrapFetch("normal", transport)("https://fixture.invalid/responses", init)).toBe(response);
  });
  expect(events.find(event => event.phase === "headers_received")?.httpStatus).toBe(200);
  expect(events.some(event => event.phase === "body_complete")).toBe(true);
  expect(budget.used).toEqual({ normal: 1, fast: 0 }); expect(transport).toHaveBeenCalledOnce();
});
