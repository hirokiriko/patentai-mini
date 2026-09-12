import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  construct: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  clients: [] as EventEmitter[],
}));

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      constructor(config: unknown) {
        super();
        fakes.construct(config);
        fakes.clients.push(this);
      }
      connect = fakes.connect;
      query = fakes.query;
      end = fakes.end;
    },
  };
});

import { checkDatabaseHealth } from "./health";

const fictionalUrl = "postgresql://fictional-user:fictional-password@fictional-host.invalid/fictional-db?sslmode=verify-full";
const failure = new Error("FICTIONAL_HEALTH_ERROR_SENTINEL");
const logMethods = ["log", "error", "warn", "info", "debug", "trace"] as const;

describe("health database check", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", fictionalUrl);
    fakes.clients.length = 0;
    fakes.connect.mockResolvedValue(undefined);
    fakes.query.mockResolvedValue({ rows: [{ ok: 1 }] });
    fakes.end.mockResolvedValue(undefined);
    for (const method of logMethods) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    for (const method of logMethods) expect(console[method]).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([undefined, ""])("does not construct a client with missing config (%s)", async (url) => {
    vi.stubEnv("DATABASE_URL", url);
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.construct).not.toHaveBeenCalled();
    expect(fakes.connect).not.toHaveBeenCalled();
    expect(fakes.query).not.toHaveBeenCalled();
    expect(fakes.end).not.toHaveBeenCalled();
  });

  it("uses one dedicated client, fixed SQL and bounded driver settings without overriding TLS", async () => {
    expect(await checkDatabaseHealth()).toBe(true);
    expect(fakes.construct).toHaveBeenCalledExactlyOnceWith({
      connectionString: fictionalUrl,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
      query_timeout: 3000,
    });
    expect(fakes.connect).toHaveBeenCalledExactlyOnceWith();
    expect(fakes.query).toHaveBeenCalledExactlyOnceWith("SELECT 1 AS ok");
    expect(fakes.end).toHaveBeenCalledExactlyOnceWith();
    expect(fakes.connect.mock.invocationCallOrder[0]).toBeLessThan(fakes.query.mock.invocationCallOrder[0]);
    expect(fakes.query.mock.invocationCallOrder[0]).toBeLessThan(fakes.end.mock.invocationCallOrder[0]);
  });

  it("rereads configuration and checks a new client on every request", async () => {
    expect(await checkDatabaseHealth()).toBe(true);
    vi.stubEnv("DATABASE_URL", "postgresql://second-fictional-host.invalid/second-fictional-db");
    expect(await checkDatabaseHealth()).toBe(true);
    expect(fakes.construct.mock.calls[1][0].connectionString).toBe(process.env.DATABASE_URL);
    expect(fakes.clients[0]).not.toBe(fakes.clients[1]);
    expect(fakes.connect).toHaveBeenCalledTimes(2);
    expect(fakes.query).toHaveBeenCalledTimes(2);
    expect(fakes.end).toHaveBeenCalledTimes(2);
  });

  it("handles constructor exceptions", async () => {
    fakes.construct.mockImplementation(() => { throw failure; });
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.end).not.toHaveBeenCalled();
  });

  it.each(["connect", "query", "end"] as const)("handles %s rejection and ends once without retry", async (phase) => {
    fakes[phase].mockRejectedValue(failure);
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.connect).toHaveBeenCalledTimes(1);
    expect(fakes.query).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(fakes.end).toHaveBeenCalledTimes(1);
  });

  it.each(["connect", "query", "end"] as const)("handles synchronous %s exceptions and ends once", async (phase) => {
    fakes[phase].mockImplementation(() => { throw failure; });
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.query).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(fakes.end).toHaveBeenCalledTimes(1);
  });

  it.each(["connect", "query"] as const)("handles driver %s timeout rejection and waits for cleanup", async (phase) => {
    vi.useFakeTimers();
    fakes[phase].mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(failure), 3000);
    }));
    const result = checkDatabaseHealth();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fakes.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(fakes.end).toHaveBeenCalledTimes(1);
    expect(fakes.query).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
  });

  it.each([
    undefined, null, {}, { rows: null }, { rows: {} }, { rows: [] },
    { rows: [null] }, { rows: [{}] }, { rows: [{ ok: "1" }] },
    { rows: [{ ok: 0 }] }, { rows: [{ ok: 1 }, { ok: 1 }] },
  ])("rejects malformed results (%j) and cleans up", async (result) => {
    fakes.query.mockResolvedValue(result);
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.query).toHaveBeenCalledTimes(1);
    expect(fakes.end).toHaveBeenCalledTimes(1);
  });

  it.each(["connect", "query", "end"] as const)("handles repeated error events during %s even if the operation resolves", async (phase) => {
    fakes[phase].mockImplementation(async () => {
      fakes.clients[0].emit("error", failure);
      fakes.clients[0].emit("error", failure);
      return phase === "query" ? { rows: [{ ok: 1 }] } : undefined;
    });
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.query).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(fakes.end).toHaveBeenCalledTimes(1);
  });

  it("handles rejection together with error events and late events after failed cleanup", async () => {
    fakes.query.mockImplementation(async () => {
      fakes.clients[0].emit("error", failure);
      throw failure;
    });
    fakes.end.mockRejectedValue(failure);
    expect(await checkDatabaseHealth()).toBe(false);
    expect(fakes.end).toHaveBeenCalledTimes(1);
    expect(() => fakes.clients[0].emit("error", failure)).not.toThrow();
  });

  it("does not return success before end settles", async () => {
    let finishEnd!: () => void;
    const ending = new Promise<void>((resolve) => { finishEnd = resolve; });
    fakes.end.mockReturnValue(ending);
    let settled = false;
    const result = checkDatabaseHealth().then((ok) => { settled = true; return ok; });
    await vi.waitFor(() => expect(fakes.end).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    finishEnd();
    expect(await result).toBe(true);
  });
});
