import { afterEach, expect, it, vi } from "vitest";
import { comparisonObservation } from "./observation";

const id = "12345678-1234-4234-8234-123456789abc";
afterEach(() => vi.restoreAllMocks());

it("emits only bounded fields and isolates operation identities and closed scopes", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const first = comparisonObservation(id), second = comparisonObservation(id.replace("12345678", "87654321"));
  first.emit("request_timing", { stage: "source_reading", timing: { attempt: 4, phase: "stopped", elapsedMs: 420000,
    abortSource: "request", stopReason: "timeout" } });
  second.emit("callback_started"); first.close(); first.emit("callback_completed");
  comparisonObservation("PRIVATE_SOURCE").emit("callback_started");
  expect(log).toHaveBeenCalledTimes(2);
  const rows = log.mock.calls.map(row => JSON.parse(String(row[1])));
  expect(rows[0]).toMatchObject({ operationId: id, event: "request_timing", attempt: 4, stage: "source_reading", phase: "stopped", stopReason: "timeout", requestElapsedMs: 420000 });
  expect(rows[1].operationId).not.toBe(id);
  expect(Object.keys(rows[0]).sort()).toEqual(["abortSource", "attempt", "elapsedMs", "event", "operationId", "phase", "requestElapsedMs", "stage", "stopReason"]);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_SOURCE");
});

it.each([false, true])("does not turn a logger error into a product error, async=%s", async asynchronous => {
  vi.spyOn(console, "info").mockImplementation(() => {
    if (asynchronous) return Promise.reject(Error("PRIVATE_ERROR")) as unknown as void;
    throw Error("PRIVATE_ERROR");
  });
  expect(() => comparisonObservation(id).emit("source_audit_saved", { answers: 3, tasks: 6 })).not.toThrow();
  await Promise.resolve();
});

it("does not serialize extra fields, exceptions or unrecognized labels", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const diagnostic = comparisonObservation(id);
  diagnostic.emit("execution_rejected", { stage: "PRIVATE_STAGE", kind: "PRIVATE_ERROR", answers: Infinity, tasks: -1,
    source: "PRIVATE_SOURCE", error: Error("PRIVATE_ERROR"), url: "https://private.invalid/secret" } as never);
  expect(JSON.parse(String(log.mock.calls[0][1]))).toEqual({ operationId: id, event: "execution_rejected", elapsedMs: expect.any(Number) });
  diagnostic.emit("request_timing", { timing: { attempt: 1, phase: "stopped", elapsedMs: Infinity, abortSource: null, stopReason: "PRIVATE" } as never });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|private.invalid|stack|source/);
  for (let n = 0; n < 1030; n++) diagnostic.emit("callback_started");
  expect(log).toHaveBeenCalledTimes(1024);
});

it.each([27, 28, 29])("preserves generation/review timing through the existing maximum request ordinal %s", attempt => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  comparisonObservation(id).emit("request_timing", { timing: { attempt, phase: "stopped", stopReason: "timeout", elapsedMs: 210000, abortSource: "request" } });
  const row = JSON.parse(String(log.mock.calls[0][1]));
  if (attempt <= 28) expect(row).toMatchObject({ attempt, phase: "stopped", stopReason: "timeout" });
  else { expect(row.attempt).toBeUndefined(); expect(row.stopReason).toBeUndefined(); }
});
