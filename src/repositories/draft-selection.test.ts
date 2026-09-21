import { drizzle } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fictionalDraft } from "../lib/current-draft-fixtures.test-support";
const seam = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn() }));
vi.mock("../db", () => ({ db: seam }));
import { draftPatentRepo } from "./drizzle";

type Query = { sql: string; params: unknown[] };
const queries: Query[] = [];
function wrap(builder: object, rows: unknown[]): object {
  return new Proxy(builder, { get(target, key) {
    if (key === "then") return (resolve: (rows: unknown[]) => void) => {
      queries.push((target as { toSQL(): Query }).toSQL()); resolve(rows);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args), rows) : value;
  } });
}
beforeEach(() => {
  vi.clearAllMocks(); queries.length = 0; const mock = drizzle.mock();
  seam.select.mockImplementation(() => wrap(mock.select(), [fictionalDraft(9)]));
  seam.update.mockImplementation((...args: Parameters<typeof mock.update>) => wrap(mock.update(...args), [fictionalDraft(9)]));
  seam.insert.mockImplementation((...args: Parameters<typeof mock.insert>) => wrap(mock.insert(...args), [fictionalDraft(10)]));
});
describe("main integration SQL selection", () => {
  it("selects the case's latest main and updates exactly that ID, retaining older rows", async () => {
    await draftPatentRepo.upsertMain({ caseId: 7, sourceFilePath: "fictional.txt", parsedText: "架空統合本文" });
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain('"draft_patents"."case_id" =');
    expect(queries[0].sql).toContain('"draft_patents"."kind" =');
    expect(queries[0].sql).toContain('order by "draft_patents"."draft_id" desc limit');
    expect(queries[0].params).toEqual([7, "main", 1]);
    expect(queries[1].sql).toContain('"extracted_claims_json" =');
    expect(queries[1].sql).toContain('where "draft_patents"."draft_id" =');
    expect(queries[1].params).toEqual(["fictional.txt", "架空統合本文", null, 9]);
    expect(seam.insert).not.toHaveBeenCalled();
  });
  it("creates a main only when the bounded main lookup is empty", async () => {
    const mock = drizzle.mock(); seam.select.mockImplementation(() => wrap(mock.select(), []));
    await draftPatentRepo.upsertMain({ caseId: 7, sourceFilePath: "fictional.txt", parsedText: "架空統合本文" });
    expect(seam.update).not.toHaveBeenCalled(); expect(seam.insert).toHaveBeenCalledTimes(1);
    expect(queries[1].params).toContain(7); expect(queries[1].params).toContain("main");
  });
});
