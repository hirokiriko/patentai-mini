import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { parseManualConfiguration } from "../src/lib/koho-import/manual-cli-config";
import { saveManualPlan } from "../src/lib/koho-import/manual-cli-db";
import type { KohoImportPlan } from "../src/lib/koho-import/types";

const calls = vi.hoisted(() => ({ mode: "success", end: vi.fn(), write: vi.fn(), connect: vi.fn(), saving: vi.fn() }));
const target = { host: "127.0.0.1", port: 12345, database: "koho_manual_import_test_fictional", user: "fictional" };
const sentinel = "FICTIONAL_PRIVATE_TRANSPORT_SENTINEL";
vi.mock("pg", async importOriginal => {
  const { DatabaseError } = await importOriginal<typeof import("pg")>();
  return { DatabaseError, Client: class extends EventEmitter {
  async connect() { calls.connect(); if (calls.mode === "connect") throw Error(sentinel); }
  async query(query: string | { text: string }) {
    const text = typeof query === "string" ? query : query.text;
    if (text.includes("scope_ok")) return { rows: [{ scope_ok: true, tables_ok: calls.mode !== "privilege", sequences_ok: true, isolated_ok: true }] };
    if (text.includes("pg_roles where rolname=current_user")) return { rows: [{ ...target, db: target.database, usr: target.user, major: 16 }] };
    if (text === "insert") {
      calls.write();
      if (calls.mode === "write") throw Error(sentinel);
      if (calls.mode === "EPIPE") throw Object.assign(Error(sentinel), { code: "EPIPE" });
      if (calls.mode === "rollback") throw Object.assign(new DatabaseError(sentinel, 100, "error"), { code: "23514" });
    }
    if (text === "commit" && calls.mode === "commit") throw Error(sentinel);
    return { rows: [] };
  }
  async end() { calls.end(); }
} }; });
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: (client: unknown) => client }));
vi.mock("../src/repositories/drizzle", () => ({ saveKohoImportPlan: async (client: { query: (s: string) => Promise<unknown> }) => {
  try { await client.query("begin"); await client.query("insert"); await client.query("commit"); }
  catch (error) { await client.query("rollback"); throw error; }
  return { disposition: "inserted", savedDocumentCount: 1 };
} }));
const config = () => parseManualConfiguration({ mode: "apply", maxFileBytes: 1000, maxTotalBytes: 1000,
  files: [{ packageType: "JPA", path: process.cwd() }], connection: { ...target, password: sentinel }, expectedTarget: target });
beforeEach(() => { calls.mode = "success"; vi.clearAllMocks(); });
it.each(["write", "commit", "EPIPE"])("keeps %s transport loss unknown even after rollback acknowledgement, with zero retries", async mode => {
  calls.mode = mode;
  const result = await saveManualPlan(config(), { documentCount: 1 } as KohoImportPlan, calls.saving);
  expect(result).toEqual({ outcome: "save_outcome_unknown", savedDocumentCount: 0 });
  expect(calls.write).toHaveBeenCalledOnce(); expect(calls.end).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(sentinel);
});
it.each(["connect", "privilege"])("stops %s failure before any save", async mode => {
  calls.mode = mode;
  expect(await saveManualPlan(config(), { documentCount: 1 } as KohoImportPlan, calls.saving)).toEqual({ outcome: "failed_before_save", savedDocumentCount: 0 });
  expect(calls.write).not.toHaveBeenCalled(); expect(calls.saving).not.toHaveBeenCalled(); expect(calls.end).toHaveBeenCalledOnce();
});
it("distinguishes an acknowledged SQL rejection and rollback from an unknown COMMIT", async () => {
  calls.mode = "rollback";
  expect(await saveManualPlan(config(), { documentCount: 1 } as KohoImportPlan, calls.saving)).toEqual({ outcome: "failed_before_save", savedDocumentCount: 0 });
  expect(calls.write).toHaveBeenCalledOnce();
});
it("reports an acknowledged commit once", async () => {
  expect(await saveManualPlan(config(), { documentCount: 1 } as KohoImportPlan, calls.saving)).toEqual({ outcome: "inserted", savedDocumentCount: 1 });
  expect(calls.write).toHaveBeenCalledOnce(); expect(calls.saving).toHaveBeenCalledOnce();
});
