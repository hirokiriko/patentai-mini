import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manualFixture } from "./koho-manual-import-fixtures";
import type { ManualConfiguration } from "../src/lib/koho-import/manual-cli-config";

// Opt-in creates exactly one new, disposable container/database. No saved credentials.
// Without opt-in these tests remain SKIP; CI does not establish Local DB acceptance.
describe.skipIf(process.env.KOHO_MANUAL_LOCAL_DB_TEST !== "1")("manual CLI isolated PostgreSQL 16", () => {
  let directory: string, container: string, owned = false, admin: Client | undefined;
  let connection: NonNullable<ManualConfiguration["connection"]>;
  const files: { packageType: "JPA" | "JPB"; path: string }[] = [];
  let initialBytes: Buffer[];
  const childEnv = () => ({ NODE_ENV: "test" as const, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH });
  async function command(file: string, args: string[], input = "", extraEnv: Record<string, string | undefined> = {}, timeout = 30_000) {
    return await new Promise<{ code: number | null; output: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(file, args, { windowsHide: true, env: { ...childEnv(), ...extraEnv } });
      let output = "", stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(Error("isolated_process_timeout")); }, timeout);
      child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { stderr += x; });
      child.on("error", () => { clearTimeout(timer); reject(Error("isolated_process_unavailable")); });
      child.on("close", code => { clearTimeout(timer); resolvePromise({ code, output, stderr }); });
      child.stdin.on("error", () => undefined); child.stdin.end(input);
    });
  }
  const docker = (args: string[], env: Record<string, string | undefined> = {}) => command("docker", ["--config", join(directory, "docker-config"), ...args], "", env);
  const config = (selected = files, allowReviewRequired = false) => {
    const { password: _password, ...expectedTarget } = connection; void _password;
    return { mode: "apply", maxFileBytes: 1_000_000, maxTotalBytes: 4_000_000,
      files: selected, connection, expectedTarget, allowReviewRequired };
  };
  const run = async (selected = files, allowReviewRequired = false) => {
    const result = await command(process.execPath, [resolve(".koho-ops/manual/scripts/koho-manual-import.js")], JSON.stringify(config(selected, allowReviewRequired)));
    expect(result.stderr === "").toBe(true);
    expect(!result.output.includes(connection.password) && !result.output.includes(directory)).toBe(true);
    return JSON.parse(result.output) as { exitCode: number; results: { outcome: string; includesReviewRequired: boolean }[] };
  };
  const sql = async (query: string, values?: unknown[]) => {
    try { return (await admin!.query(query, values)).rows; }
    catch { throw Error("isolated_sql_check_failed"); }
  };
  const snapshot = async () => JSON.stringify(await sql(`select row_to_json(r)::text as run,
    (select json_agg(d order by document_id)::text from public.koho_import_documents d where d.import_id=r.import_id) as docs,
    (select json_build_array(updated_at::text, import_id)::text from public.koho_import_runs order by updated_at desc,import_id desc limit 1) as cursor
    from public.koho_import_runs r order by import_id`));
  beforeAll(async () => {
    let phase = "compile";
    try {
      directory = await mkdtemp(join(tmpdir(), "koho-manual-db-tests-"));
      const suffix = randomBytes(8).toString("hex"), password = randomBytes(24).toString("hex");
      container = `koho-manual-test-${suffix}`;
      const database = `koho_manual_import_test_${suffix}`;
      const built = await command(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-manual-import.tsconfig.json"], "", {}, 60_000);
      if (built.code !== 0) throw Error();
      phase = "container_create";
      const create = await docker(["create", "--name", container, "--label", "patentai.issue=99", "--publish", "127.0.0.1::5432",
        "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", "postgres:16"], { POSTGRES_PASSWORD: password, POSTGRES_DB: database });
      if (create.code !== 0) throw Error(); owned = true;
      phase = "container_start";
      if ((await docker(["start", container])).code !== 0) throw Error();
      const portResult = await docker(["port", container, "5432/tcp"]);
      phase = "local_connection";
      const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(portResult.output); if (!match) throw Error();
      const port = Number(match[1]);
      for (let n = 0; n < 40; n++) {
        const attempt = new Client({ host: "127.0.0.1", port, database, user: "postgres", password, ssl: false, connectionTimeoutMillis: 1000 });
        attempt.on("error", () => undefined);
        try { await attempt.connect(); admin = attempt; break; }
        catch { await attempt.end().catch(() => undefined); await new Promise(r => setTimeout(r, 250)); }
      }
      if (!admin || (await sql("select current_setting('server_version_num')::int / 10000 as major"))[0].major !== 16) throw Error();
      phase = "existing_migrations";
      await migrate(drizzle(admin), { migrationsFolder: resolve("drizzle") });
      phase = "minimal_role";
      const user = `manual_import_${suffix}`, importPassword = randomBytes(24).toString("hex");
      await sql(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      await sql(`CREATE ROLE ${user} LOGIN PASSWORD '${importPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await sql(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
      await sql(`GRANT USAGE ON SCHEMA public TO ${user}`);
      await sql(`GRANT SELECT, INSERT ON public.koho_import_runs, public.koho_import_documents TO ${user}`);
      await sql(`GRANT USAGE ON SEQUENCE public.koho_import_runs_import_id_seq, public.koho_import_documents_document_id_seq TO ${user}`);
      connection = { host: "127.0.0.1", port, database, user, password: importPassword };
      for (const [type, count, options] of [["JPA", 2, {}], ["JPB", 3, {}], ["JPA", 2, { changed: true }], ["JPA", 1, { review: true }]] as const) {
        const path = join(directory, `完全架空 ${files.length}.zip`);
        await writeFile(path, manualFixture(type, count, options)); files.push({ packageType: type, path });
      }
      initialBytes = await Promise.all(files.map(f => readFile(f.path)));
    } catch { throw Error(`isolated_postgresql16_setup_failed_${phase}`); }
  }, 120_000);
  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    if (owned) {
      const removed = await docker(["rm", "--force", "--volumes", container]);
      expect(removed.code === 0).toBe(true);
      expect((await docker(["container", "inspect", container])).code !== 0).toBe(true);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 40_000);
  it("persists JPA/JPB with minimal privileges through the compiled entrypoint", async () => {
    const result = await run(files.slice(0, 2)); expect(result.exitCode).toBe(0);
    expect(result.results.map(r => r.outcome)).toEqual(["inserted", "inserted"]);
    expect((await sql("select count(*)::int as n from public.koho_import_documents"))[0].n).toBe(5);
  });
  it("reuses identical/renamed bytes without changing any row, microsecond timestamp or watch cursor", async () => {
    const before = await snapshot(); const renamed = join(directory, "別名 同内容.zip"); await writeFile(renamed, initialBytes[0]);
    const result = await run([...files.slice(0, 2), { packageType: "JPA", path: renamed }]);
    expect(result.results.map(r => r.outcome)).toEqual(["reused", "reused", "reused"]);
    expect(await snapshot() === before).toBe(true);
  });
  it("keeps an earlier commit after batch failure and resumes by verified reuse", async () => {
    const broken = join(directory, "broken.zip"); await writeFile(broken, "FICTIONAL TSV\tUNSUPPORTED");
    const result = await run([files[2], { packageType: "JPA", path: broken }, files[3]]);
    expect(result.results.map(r => r.outcome)).toEqual(["inserted", "failed_before_save", "not_processed"]);
    const before = await snapshot(); expect((await run([files[2]])).results[0].outcome).toBe("reused");
    expect(await snapshot() === before).toBe(true);
    // Same number with changed content is preserved as another immutable identity.
    expect((await sql("select count(*)::int as n from (select publication_number from public.koho_import_documents group by publication_number having count(distinct content_sha256)>1) x"))[0].n).toBe(2);
  });
  it("refuses review by default and explicitly retains review on save", async () => {
    const before = await snapshot(); expect((await run([files[3]])).results[0].outcome).toBe("review_not_saved");
    expect(await snapshot() === before).toBe(true);
    expect((await run([files[3]], true)).results[0]).toMatchObject({ outcome: "inserted", includesReviewRequired: true });
  });
  it("rolls back a package on SQL failure and resumes without blind retry", async () => {
    const path = join(directory, "rollback.zip"); await writeFile(path, manualFixture("JPB", 1, { issue: "FICTIONAL-ROLLBACK-ISSUE" }));
    const before = await snapshot();
    await sql("CREATE FUNCTION manual_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FICTIONAL_PRIVATE_SENTINEL'; END $$");
    await sql("CREATE TRIGGER manual_fixture_failure BEFORE INSERT ON public.koho_import_documents FOR EACH ROW EXECUTE FUNCTION manual_fixture_failure()");
    try { expect((await run([{ packageType: "JPB", path }])).results[0].outcome).toBe("failed_before_save"); }
    finally { await sql("DROP TRIGGER manual_fixture_failure ON public.koho_import_documents"); await sql("DROP FUNCTION manual_fixture_failure()"); }
    expect(await snapshot() === before).toBe(true);
    expect((await run([{ packageType: "JPB", path }])).results[0].outcome).toBe("inserted");
  });
  it("refuses inconsistent stored rows without changing rows/cursor", async () => {
    const [row] = await sql("select document_id, invention_title from public.koho_import_documents order by document_id limit 1");
    await sql("update public.koho_import_documents set invention_title='FICTIONAL-INCORRECT' where document_id=$1", [row.document_id]);
    const before = await snapshot();
    try { expect((await run([files[0]])).results[0].outcome).toBe("failed_before_save"); expect(await snapshot() === before).toBe(true); }
    finally { await sql("update public.koho_import_documents set invention_title=$1 where document_id=$2", [row.invention_title, row.document_id]); }
  });
  it("refuses column-level excess privileges and preserves operator inputs", async () => {
    const before = await snapshot();
    await sql(`GRANT UPDATE(claims_text) ON public.koho_import_documents TO ${connection.user}`);
    try { expect((await run([files[0]])).results[0].outcome).toBe("failed_before_save"); expect(await snapshot() === before).toBe(true); }
    finally { await sql(`REVOKE UPDATE(claims_text) ON public.koho_import_documents FROM ${connection.user}`); }
    expect((await Promise.all(files.map(f => readFile(f.path)))).every((b, i) => b.equals(initialBytes[i]))).toBe(true);
  });
  it("records real inserts/reuse and preserves a committed insert after receipt failure", async () => {
    const first = join(directory, "receipt-first.zip"), second = join(directory, "receipt-second.zip");
    await writeFile(first, manualFixture("JPA", 1, { issue: "FICTIONAL-RECEIPT-FIRST" }));
    await writeFile(second, manualFixture("JPB", 1, { issue: "FICTIONAL-RECEIPT-SECOND" }));
    const selected = [{ packageType: "JPA" as const, path: first }, { packageType: "JPB" as const, path: second }];
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const hashes = await Promise.all(selected.map(async file => digest(await readFile(file.path))));
    const entry = resolve(".koho-ops/manual/scripts/koho-manual-import.js");
    const failedReceipt = join(directory, "receipt-incomplete.jsonl"), guard = join(directory, "receipt-failure.cjs");
    await writeFile(guard, `const p=require('node:fs/promises'),open=p.open;
      p.open=async function(path,...args){const h=await open.call(this,path,...args);if(path===${JSON.stringify(failedReceipt)}){
        const write=h.write.bind(h);h.write=async function(...a){if(JSON.parse(a[0].toString()).type==='file_finished')throw Error('FICTIONAL_PRIVATE_SENTINEL');return write(...a);};}return h;};`);
    const withReceipt = (path: string, selectedFiles = selected) => ({ ...config(selectedFiles), receipt: { path, privateDirectoryConfirmed: true } });
    const failed = await command(process.execPath, ["--require", guard, entry], JSON.stringify(withReceipt(failedReceipt)));
    expect(failed.stderr === "" && !failed.output.includes(connection.password) && !failed.output.includes(directory)).toBe(true);
    const failure = JSON.parse(failed.output);
    expect(failure).toMatchObject({ exitCode: 2, receiptStatus: "incomplete", savedRecordCount: 1,
      results: [{ outcome: "inserted", savedDocumentCount: 1 }, { outcome: "not_processed" }] });
    expect((await sql("select count(*)::int as n from public.koho_import_runs where source_sha256=$1", [hashes[0]]))[0].n).toBe(1);
    expect((await sql("select count(*)::int as n from public.koho_import_runs where source_sha256=$1", [hashes[1]]))[0].n).toBe(0);
    const successReceipt = join(directory, "receipt-retry.jsonl");
    const resumed = await command(process.execPath, [entry], JSON.stringify(withReceipt(successReceipt)));
    expect(resumed.code).toBe(0); expect(resumed.stderr).toBe("");
    expect(JSON.parse(resumed.output)).toMatchObject({ receiptStatus: "complete", savedRecordCount: 1,
      results: [{ outcome: "reused", savedDocumentCount: 1 }, { outcome: "inserted", savedDocumentCount: 1 }] });
    const data = (await readFile(successReceipt, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(data.filter(x => x.type === "input_verified").map(x => x.sha256)).toEqual(hashes);
    expect(data.filter(x => x.type === "file_finished").map(x => x.outcome)).toEqual(["reused", "inserted"]);
    expect(data.at(-1)).toMatchObject({ type: "batch_finished", savedRecordCount: 1 });
    const before = await snapshot(), reuseReceipt = join(directory, "receipt-reused.jsonl");
    const reused = await command(process.execPath, [entry], JSON.stringify(withReceipt(reuseReceipt)));
    expect(JSON.parse(reused.output)).toMatchObject({ receiptStatus: "complete", savedRecordCount: 0,
      results: [{ outcome: "reused" }, { outcome: "reused" }] });
    expect(await snapshot()).toBe(before);
    expect(await Promise.all(selected.map(async file => digest(await readFile(file.path))))).toEqual(hashes);
  });
});
