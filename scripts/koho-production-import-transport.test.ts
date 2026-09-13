import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildMinimalFictionalPackage } from "../src/lib/koho-package/__fixtures__/fictional-package";
import { importApprovedPackage } from "./koho-production-import";

const calls = vi.hoisted(() => ({ end: vi.fn(), save: vi.fn() }));
vi.mock("../src/repositories/drizzle", () => ({ saveKohoImportPlan: calls.save }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Client: class extends EventEmitter {
    async connect() { this.emit("error", new Error("fictional_private_transport_details")); }
    async query() { return { rows: [{ db: "koho_issue89_fixture", usr: "fixture", major: 16,
      recovery: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolreplication: false, rolbypassrls: false, bytes: "0", lsn: "0/0" }] }; }
    async end() { calls.end(); }
  } };
});

it("handles an idle socket error without raw error output, write or leaked snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koho-issue89-transport-"));
  try {
    const bytes = buildMinimalFictionalPackage("JPA"), name = "JPA_2026155.ZIP", path = join(directory, name);
    await writeFile(path, bytes);
    const target = { host: "127.0.0.1", port: 5432, database: "koho_issue89_fixture", user: "fixture" };
    const error = await importApprovedPackage({ approval: "LOCAL_IMPORT_FIRST_V1", mode: "local", fixture: true,
      connection: { ...target, password: "fictional" }, expectedTarget: target,
      package: { name, path, type: "JPA", bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), documents: 1 } }).catch(e => e);
    expect(error.message).toBe("koho_import_stopped");
    expect(calls.save).not.toHaveBeenCalled(); expect(calls.end).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([name]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
