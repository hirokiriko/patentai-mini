import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bibliographyFixture } from "./bibliography-fixtures.test-support";
const seam = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../db", () => ({ db: { transaction: seam.transaction } }));
import { patentWatchRepo } from "../../repositories/drizzle";

function record(rows: unknown[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [], controls: string[] = [];
  const mock = drizzle.mock(), write = vi.fn(() => { throw Error("unexpected write"); });
  const wrap = (builder: object): object => new Proxy(builder, { get(target, key) {
    if (key === "then") return (resolve: (rows: unknown[]) => void) => {
      queries.push((target as { toSQL(): { sql: string; params: unknown[] } }).toSQL()); resolve(rows);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args)) : value;
  } });
  seam.transaction.mockImplementation(async body => body({ select: (fields: Parameters<typeof mock.select>[0]) => wrap(mock.select(fields)),
    execute: async (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => { controls.push(new PgDialect().sqlToQuery(statement).sql); }, insert: write, update: write, delete: write }));
  return { queries, controls, write };
}
beforeEach(() => vi.clearAllMocks());
describe("bibliography SQL boundary", () => {
  it("reads the case-owned finding and exact reference in one bounded read-only snapshot", async () => {
    const captured = record([bibliographyFixture()]);
    expect((await patentWatchRepo.readFindingBibliography(7, 11))?.bibliography?.applicants.state).toBe("available");
    expect(seam.transaction).toHaveBeenCalledTimes(1);
    expect(seam.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    expect(captured.controls).toEqual(["set local statement_timeout = '5s'", "set local lock_timeout = '3s'", "set local idle_in_transaction_session_timeout = '5s'"]);
    expect(captured.queries).toHaveLength(1);
    const query = captured.queries[0]; expect(query.params).toEqual([65_536, 7, 11, 1]);
    for (const predicate of ['"case_watch_settings"."case_id" = "cases"."case_id"', '"case_watch_findings"."watch_id" = "case_watch_settings"."watch_id"',
      '"koho_import_documents"."document_id" = "case_watch_findings"."corpus_document_id"', '"cases"."case_id" =', '"case_watch_findings"."finding_id" =']) expect(query.sql).toContain(predicate);
    expect(query.sql).toContain('case when octet_length("koho_import_documents"."applicants_json")');
    expect(query.sql).not.toMatch(/select \*|claims_text|abstract_text|normalized_entry_path|source_metadata_json|parse_issues_json|for update|update |insert /i);
    expect(captured.write).not.toHaveBeenCalled();
  });
  it("does not fall back to a corpus search when no finding exists", async () => {
    const captured = record([]); expect(await patentWatchRepo.readFindingBibliography(7, 11)).toBeNull(); expect(captured.queries).toHaveLength(1);
  });
  it("rejects invalid IDs before opening a transaction", async () => {
    expect(await patentWatchRepo.readFindingBibliography(7, 0)).toBeNull(); expect(seam.transaction).not.toHaveBeenCalled();
  });
});
