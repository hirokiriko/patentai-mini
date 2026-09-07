import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  findAll: vi.fn(),
  construct: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@/repositories", () => ({ caseRepo: { findAll: fakes.findAll } }));
vi.mock("pg", () => ({
  Client: class {
    constructor(config: unknown) { fakes.construct(config); }
    connect = fakes.connect;
    query = fakes.query;
    end = fakes.end;
    on() { return this; }
  },
}));

import { GET } from "./route";

const logMethods = ["log", "error", "warn", "info", "debug", "trace"] as const;

describe("health HTTP contract", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://fictional-user:fictional-password@fictional-host.invalid/fictional-db");
    fakes.findAll.mockResolvedValue([]);
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
  });

  it("returns only the minimal success object without reading cases", async () => {
    const response = await GET();
    expect(await response.json()).toStrictEqual({
      ok: true, status: "ok", database: { ok: true, type: "postgres" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify([...response.headers])).not.toMatch(/fictional|sentinel/i);
    expect(fakes.findAll).not.toHaveBeenCalled();
  });

  it("returns 503 and no exception details when the database fails", async () => {
    const error = new Error("FICTIONAL_ERROR_SENTINEL");
    fakes.findAll.mockRejectedValue(error);
    fakes.connect.mockRejectedValue(error);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      ok: false, status: "unavailable", database: { ok: false, type: "postgres" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify([...response.headers])).not.toMatch(/fictional|sentinel/i);
    expect(fakes.findAll).not.toHaveBeenCalled();
  });

  it.each([undefined, "postgresql://fictional-host.invalid/fictional-db"])("does not construct or connect on module import during build (%s)", async (url) => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", url);
    const route = await import("./route");
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(fakes.construct).not.toHaveBeenCalled();
    expect(fakes.connect).not.toHaveBeenCalled();
    expect(fakes.query).not.toHaveBeenCalled();
    expect(fakes.findAll).not.toHaveBeenCalled();
  });

  it("does not reuse a previous readiness result", async () => {
    expect((await GET()).status).toBe(200);
    fakes.query.mockRejectedValueOnce(new Error("FICTIONAL_ERROR_SENTINEL"));
    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(200);
    expect(fakes.construct).toHaveBeenCalledTimes(3);
    expect(fakes.connect).toHaveBeenCalledTimes(3);
    expect(fakes.query).toHaveBeenCalledTimes(3);
    expect(fakes.end).toHaveBeenCalledTimes(3);
    expect(fakes.findAll).not.toHaveBeenCalled();
  });

  it("returns the same unavailable response without constructing a client when configuration is absent", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      ok: false, status: "unavailable", database: { ok: false, type: "postgres" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fakes.construct).not.toHaveBeenCalled();
    expect(fakes.findAll).not.toHaveBeenCalled();
  });

  it.each(["construct", "query", "end", "invalid result", "timeout"] as const)("keeps %s failures at the same private HTTP boundary", async (phase) => {
    const error = new Error("FICTIONAL_ERROR_SENTINEL postgresql://fictional-user:fictional-password@fictional-host.invalid/fictional-db");
    if (phase === "construct") fakes.construct.mockImplementation(() => { throw error; });
    else if (phase === "invalid result") fakes.query.mockResolvedValue({ rows: [] });
    else if (phase === "timeout") fakes.query.mockRejectedValue(error);
    else fakes[phase].mockRejectedValue(error);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      ok: false, status: "unavailable", database: { ok: false, type: "postgres" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify([...response.headers])).not.toMatch(/fictional|sentinel/i);
    expect(fakes.findAll).not.toHaveBeenCalled();
  });
});
