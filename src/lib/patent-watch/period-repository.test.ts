import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePeriod, periodFixture } from "./period-fixtures.test-support";
import { PeriodReportLimitError } from "./period";

const seam = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../db", () => ({ db: { transaction: seam.transaction } }));
import { patentWatchRepo } from "../../repositories/drizzle";

// Compile actual Drizzle queries while replacing only their execution and transaction.
// This proves the repository contract, not behavior of a live PostgreSQL server.
function recordingTransaction(resultSets: unknown[][], failAt = -1) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const controls: string[] = [];
  const write = vi.fn(() => { throw new Error("unexpected write"); });
  const mockDb = drizzle.mock();
  const tx = {
    execute: vi.fn(async (statement) => { controls.push(new PgDialect().sqlToQuery(statement).sql); }),
    insert: write, update: write, delete: write,
    select: vi.fn((fields) => {
      const query = mockDb.select(fields);
      // Drizzle's builder changes shape after from(); wrap each fluent return.
      const wrap = (builder: object): object => new Proxy(builder, {
        get(target, key) {
          if (key === "then") return (resolve: (rows: unknown[]) => void, reject: (error: Error) => void) => {
            const compiled = (target as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
            const index = queries.length; queries.push(compiled);
            if (index === failAt) reject(new Error("FICTIONAL_DB_FAILURE"));
            else resolve(resultSets[index] ?? []);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args)) : value;
        },
      });
      return wrap(query);
    }),
  };
  seam.transaction.mockImplementation(async (body) => body(tx));
  return { queries, controls, write, tx };
}
beforeEach(() => vi.clearAllMocks());
describe("period repository transaction seam (no live DB)", () => {
  it("enforces case/time predicates, matching watch IDs, limits and one read-only snapshot", async () => {
    const snapshot = periodFixture(21, 101);
    const { runs, findings, ...context } = snapshot;
    const recording = recordingTransaction([[context], runs, findings]);
    expect(await patentWatchRepo.readPeriodSnapshot(7, fixturePeriod)).toEqual(snapshot);
    expect(seam.transaction).toHaveBeenCalledTimes(1);
    expect(seam.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    expect(recording.controls).toEqual(["set local statement_timeout = '5s'", "set local lock_timeout = '3s'", "set local idle_in_transaction_session_timeout = '5s'"]);
    const [contextQuery, runQuery, findingQuery] = recording.queries;
    expect(contextQuery.sql).toContain('"cases"."case_id" = $1');
    expect(contextQuery.sql).not.toContain('"title"');
    for (const query of [runQuery, findingQuery]) {
      expect(query.sql).toContain('"case_watch_settings"."case_id" =');
      expect(query.sql).toContain('"case_watch_runs"."started_at" >=');
      expect(query.sql).toContain('"case_watch_runs"."started_at" <');
      expect(query.params.slice(0, 3)).toEqual([7, "2096-02-29T15:00:00.000Z", "2096-03-31T15:00:00.000Z"]);
      expect(query.sql).not.toMatch(/date_trunc|::date|for update|offset/i);
    }
    expect(runQuery.params.at(-1)).toBe(201); expect(findingQuery.params.at(-1)).toBe(4001);
    expect(findingQuery.params).toContain("completed");
    expect(findingQuery.sql).toContain('"case_watch_runs"."run_id" = "case_watch_findings"."first_run_id"');
    expect(findingQuery.sql).toContain('"case_watch_runs"."watch_id" = "case_watch_findings"."watch_id"');
    expect(findingQuery.sql).not.toMatch(/source_key|hash|claims|raw_xml|abstract|corpus_document_id/i);
    expect(recording.write).not.toHaveBeenCalled();
  });
  it.each([[200, 4000, false], [201, 0, true], [1, 4001, true]] as const)("checks limit + 1 for %i / %i", async (runs, findings, exceeds) => {
    const snapshot = periodFixture(runs, findings);
    const recording = recordingTransaction([[snapshot], snapshot.runs, snapshot.findings]);
    const pending = patentWatchRepo.readPeriodSnapshot(7, fixturePeriod);
    if (exceeds) await expect(pending).rejects.toBeInstanceOf(PeriodReportLimitError);
    else expect((await pending)?.findings).toHaveLength(4000);
    expect(recording.queries.length).toBe(runs > 200 ? 2 : 3);
    expect(recording.write).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])("propagates read failures at statement %i without writes or retries", async failAt => {
    const snapshot = periodFixture();
    const recording = recordingTransaction([[snapshot], snapshot.runs, snapshot.findings], failAt);
    await expect(patentWatchRepo.readPeriodSnapshot(7, fixturePeriod)).rejects.toThrow("FICTIONAL_DB_FAILURE");
    expect(seam.transaction).toHaveBeenCalledTimes(1); expect(recording.write).not.toHaveBeenCalled();
  });
  it("returns no case from the same bounded snapshot", async () => {
    const recording = recordingTransaction([[]]);
    expect(await patentWatchRepo.readPeriodSnapshot(7, fixturePeriod)).toBeNull(); expect(recording.queries).toHaveLength(1);
  });
  it("rejects invalid inputs before entering a transaction", async () => {
    await expect(patentWatchRepo.readPeriodSnapshot(0, fixturePeriod)).rejects.toThrow();
    await expect(patentWatchRepo.readPeriodSnapshot(7, { from: "secret", to: "secret" })).rejects.toThrow();
    expect(seam.transaction).not.toHaveBeenCalled();
  });
});
