/** Opt-in disposable PG16 with real TLS, parser, immutable persistence and private receipt. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { cloudFixture, FictionalCloudBlob } from "./koho-cloud-import-fixtures";
import { protectUpdateTestDirectory } from "./koho-update-check-fixtures";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import { inspectCloudDatabase, saveCloudPlan } from "../src/lib/koho-import/cloud-db";
import { cloudReceiptPrefix, type CloudConfiguration } from "../src/lib/koho-import/cloud-config";
import { readUpdateReceipt } from "../src/lib/koho-import/update-check-receipts";

describe.skipIf(process.env.KOHO_CLOUD_LOCAL_DB_TEST !== "1")("dedicated cloud entrypoint on isolated TLS PostgreSQL16", () => {
  let directory: string, container: string, owned = false, admin: Client | undefined, port: number, ca: string, password: string;
  let target: CloudConfiguration["expectedTarget"];
  const blob = new FictionalCloudBlob();
  let first: Awaited<ReturnType<typeof cloudFixture>>;
  async function command(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 60_000) {
    return await new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
      const child = spawn(file, args, { windowsHide: true, env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH, ...extraEnv } });
      let output = ""; const timer = setTimeout(() => { child.kill(); reject(Error("cloud_test_process_timeout")); }, timeout);
      child.stdout.on("data", x => { output += x; }); child.stderr.resume(); child.stdin.end();
      child.on("error", () => { clearTimeout(timer); reject(Error("cloud_test_process_unavailable")); });
      child.on("close", code => { clearTimeout(timer); resolvePromise({ code, output }); });
    });
  }
  const docker = (args: string[], env?: Record<string, string>) => command("docker", ["--config", join(directory, "docker-config"), ...args], env);
  const sql = async (text: string, values?: unknown[]) => {
    try { return (await admin!.query(text, values)).rows; } catch { throw Error("cloud_test_sql_failed"); }
  };
  const snapshot = async () => JSON.stringify(await sql(`select row_to_json(r)::text as run,
    (select json_agg(d order by document_id)::text from public.koho_import_documents d where d.import_id=r.import_id) as docs
    from public.koho_import_runs r order by import_id`));
  const newClient = (failure?: "sql" | "commit" | "postcommit" | "no_tls") => {
    const client = new Client({ host: "127.0.0.1", port, database: target.database, user: target.user, password,
      ssl: failure === "no_tls" ? false : { rejectUnauthorized: true, ca, servername: "localhost" },
      connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 2000, query_timeout: 6000,
      options: "-c search_path=pg_catalog,public" });
    const original = client.query;
    client.query = (async (...args: unknown[]) => {
      const first = args[0], text = typeof first === "string" ? first : (first as { text?: string })?.text ?? "";
      if (failure === "sql" && /^insert into "koho_import_documents"/i.test(text)) return await Reflect.apply(original, client, ["select 1 / 0"]);
      const result = await Reflect.apply(original, client, args);
      if (/^commit$/i.test(text) && failure === "commit") throw Error("FICTIONAL_PRIVATE_LOST_ACK");
      if (/^commit$/i.test(text) && failure === "postcommit") client.emit("error", Error("FICTIONAL_PRIVATE_POST_ACK_DISCONNECT"));
      return result;
    }) as typeof client.query;
    return client;
  };
  const save = (failure?: Parameters<typeof newClient>[0]): typeof saveCloudPlan => (c, m, p, plan, begin) => saveCloudPlan(c, m, p, plan, begin, () => newClient(failure));
  const run = (f: Awaited<ReturnType<typeof cloudFixture>>, failure?: Parameters<typeof newClient>[0]) => runCloudImport(f.config, f.blob, { password, save: save(failure) });
  const fresh = (issue: string, review = false) => cloudFixture({ blob, target, issue, review });
  beforeAll(async () => {
    let phase = "directory";
    try {
      directory = await mkdtemp(join(tmpdir(), "koho-cloud-db-tests-")); await protectUpdateTestDirectory(directory);
      const suffix = randomBytes(8).toString("hex"), managementPassword = randomBytes(24).toString("hex");
      container = `koho-cloud-test-${suffix}`; const database = `koho_cloud_test_${suffix}`;
      phase = "container_create";
      const created = await docker(["create", "--name", container, "--label", "patentai.issue=123", "--publish", "127.0.0.1::5432",
        "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", "postgres:16"], { POSTGRES_PASSWORD: managementPassword, POSTGRES_DB: database });
      if (created.code !== 0) throw Error(); owned = true;
      phase = "container_start"; if ((await docker(["start", container])).code !== 0) throw Error();
      const portMatch = /^127\.0\.0\.1:(\d+)\s*$/.exec((await docker(["port", container, "5432/tcp"])).output); if (!portMatch) throw Error(); port = Number(portMatch[1]);
      phase = "admin_connect";
      for (let n = 0; n < 40; n++) {
        const attempt = new Client({ host: "127.0.0.1", port, database, user: "postgres", password: managementPassword, ssl: false, connectionTimeoutMillis: 1000 });
        attempt.on("error", () => undefined);
        try { await attempt.connect(); admin = attempt; break; } catch { await attempt.end().catch(() => undefined); await new Promise(r => setTimeout(r, 250)); }
      }
      if (!admin) throw Error();
      phase = "existing_migrations"; await migrate(drizzle(admin), { migrationsFolder: resolve("drizzle") });
      phase = "test_tls";
      const cert = await docker(["exec", "--user", "postgres", container, "sh", "-c", "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout /tmp/cloud-test.key -out /tmp/cloud-test.crt >/dev/null 2>&1 && chmod 600 /tmp/cloud-test.key"]);
      if (cert.code !== 0) throw Error(); ca = (await docker(["exec", container, "cat", "/tmp/cloud-test.crt"])).output;
      await sql("ALTER SYSTEM SET ssl_cert_file='/tmp/cloud-test.crt'"); await sql("ALTER SYSTEM SET ssl_key_file='/tmp/cloud-test.key'");
      await sql("ALTER SYSTEM SET ssl=on"); await sql("select pg_reload_conf()");
      phase = "minimal_role"; const user = `koho_pilot_${suffix}`; password = randomBytes(24).toString("hex");
      // Retain standard PUBLIC TEMP exactly as on the approved production target.
      await sql(`CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await sql(`GRANT CONNECT ON DATABASE ${database} TO ${user}`); await sql(`GRANT USAGE ON SCHEMA public TO ${user}`);
      await sql(`GRANT SELECT,INSERT ON public.koho_import_runs,public.koho_import_documents TO ${user}`);
      await sql(`GRANT USAGE ON SEQUENCE public.koho_import_runs_import_id_seq,public.koho_import_documents_document_id_seq TO ${user}`);
      target = { host: "fictional.postgres.database.azure.com", port: 5432, database, user };
      first = await fresh("FICTIONAL-FIRST");
    } catch { throw Error(`cloud_postgresql16_setup_failed_${phase}`); }
  }, 120_000);
  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    if (owned) { expect((await docker(["rm", "--force", "--volumes", container])).code).toBe(0);
      expect((await docker(["container", "inspect", container])).code).not.toBe(0); }
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 40_000);
  it("inserts first round with real TLS and INSERT/SELECT only, preserving PUBLIC-derived TEMP", async () => {
    const inspection = newClient();
    try { await inspection.connect(); await inspectCloudDatabase(inspection, target); }
    finally { await inspection.end(); }
    const result = await run(first); expect(result).toMatchObject({ exitCode: 0, receiptAcknowledgement: "confirmed" });
    expect(result.results[0].outcome).toBe("inserted"); expect((await sql("select count(*)::int as n from public.koho_import_documents"))[0].n).toBe(1);
  });
  it("runs immutable reuse plus new insert without changing first rows/microsecond timestamps", async () => {
    const before = await snapshot(), second = await cloudFixture({ blob, target, issue: "FICTIONAL-SECOND", publicationDate: "2099-03-12" });
    second.manifest.round = 2; second.manifest.packages.unshift({ ...first.manifest.packages[0], expectedDisposition: "reused" }); await second.publish();
    const result = await run(second); expect(result.results.map(r => r.outcome)).toEqual(["reused", "inserted"]); expect(result.exitCode).toBe(0);
    const after = JSON.parse(await snapshot()); expect(JSON.stringify([after[0]]) === before).toBe(true);
  });
  it("prevents unexpected insert or reuse under the shared transaction lock", async () => {
    const before = await snapshot(), missing = await fresh("FICTIONAL-MISSING"); missing.manifest.packages[0].expectedDisposition = "reused"; await missing.publish();
    expect((await run(missing)).results[0].outcome).toBe("failed_before_save");
    const existing = await fresh("FICTIONAL-FIRST"); expect((await run(existing)).results[0].outcome).toBe("failed_before_save");
    expect(await snapshot() === before).toBe(true);
  });
  it("rejects wrong independent target and missing TLS before save", async () => {
    const before = await snapshot(), noTls = await fresh("FICTIONAL-TLS-REFUSAL");
    expect((await run(noTls, "no_tls")).results[0].outcome).toBe("failed_before_save");
    const wrong = await fresh("FICTIONAL-TARGET-REFUSAL"); wrong.config.expectedTarget = { ...wrong.config.expectedTarget, user: "fictional_other" };
    expect((await run(wrong)).exitCode).toBe(2); expect(await snapshot() === before).toBe(true);
  });
  it("rejects direct TEMP, column grant delegation, sequence SELECT and changed schema", async () => {
    const before = await snapshot();
    const changes = [
      [`GRANT TEMPORARY ON DATABASE ${target.database} TO ${target.user}`, `REVOKE TEMPORARY ON DATABASE ${target.database} FROM ${target.user}`],
      [`GRANT SELECT(claims_text) ON public.koho_import_documents TO ${target.user} WITH GRANT OPTION`, `REVOKE ALL(claims_text) ON public.koho_import_documents FROM ${target.user}`],
      [`GRANT SELECT ON SEQUENCE public.koho_import_runs_import_id_seq TO ${target.user}`, `REVOKE SELECT ON SEQUENCE public.koho_import_runs_import_id_seq FROM ${target.user}`],
      ["ALTER TABLE public.koho_import_documents ADD COLUMN fictional_extra text", "ALTER TABLE public.koho_import_documents DROP COLUMN fictional_extra"],
    ];
    for (const [index, [grant, revoke]] of changes.entries()) {
      await sql(grant);
      try { expect((await run(await fresh(`FICTIONAL-PRIVILEGE-${index}`))).results[0].outcome).toBe("failed_before_save"); }
      finally { await sql(revoke); }
    }
    expect(await snapshot() === before).toBe(true);
  });
  it("performs a real package rollback on SQL rejection without losing earlier commits", async () => {
    const before = await snapshot(), fixture = await fresh("FICTIONAL-SQL-ROLLBACK");
    expect((await run(fixture, "sql")).results[0].outcome).toBe("failed_before_save"); expect(await snapshot() === before).toBe(true);
  });
  it("keeps a lost COMMIT ACK unknown; limited DB read reconciles it and same operation cannot replay", async () => {
    const fixture = await fresh("FICTIONAL-COMMIT-UNKNOWN"), result = await run(fixture, "commit");
    expect(result.results[0].outcome).toBe("save_outcome_unknown"); expect(result.exitCode).toBe(2);
    expect((await sql("select count(*)::int as n from public.koho_import_runs where source_sha256=$1", [fixture.manifest.packages[0].sha256]))[0].n).toBe(1);
    expect((await run(fixture)).startedAcknowledged).toBe(false);
    const reconciled = await fresh("FICTIONAL-COMMIT-UNKNOWN"); reconciled.manifest.packages[0].expectedDisposition = "reused"; await reconciled.publish();
    expect((await run(reconciled)).results[0].outcome).toBe("reused");
  });
  it("retains known commit even when connection fails immediately after its ACK", async () => {
    const result = await run(await fresh("FICTIONAL-POST-COMMIT-DISCONNECT"), "postcommit");
    expect(result.results[0].outcome).toBe("inserted"); expect(result.capacityConfirmed).toBe(false); expect(result.exitCode).toBe(2);
  });
  it("preserves acknowledged insert when receipt fails; private historical prefix remains incomplete", async () => {
    const fixture = await fresh("FICTIONAL-RECEIPT-FAILURE");
    const wrapped: typeof saveCloudPlan = async (...args) => { const saved = await save()(...args); blob.fail = (name, write) => write && name.endsWith("receipt.jsonl"); return saved; };
    try {
      const result = await runCloudImport(fixture.config, blob, { password, save: wrapped });
      expect(result.results[0].outcome).toBe("inserted"); expect(result.receiptAcknowledgement).toBe("unconfirmed");
      expect(readUpdateReceipt(blob.objects.get(cloudReceiptPrefix(fixture.config) + "receipt.jsonl")!.bytes).structuralComplete).toBe(false);
      expect((await sql("select count(*)::int as n from public.koho_import_runs where source_sha256=$1", [fixture.manifest.packages[0].sha256]))[0].n).toBe(1);
    } finally { blob.fail = () => false; }
  });
  it("holds review before save and explicitly preserves review on approved insert", async () => {
    const fixture = await fresh("FICTIONAL-REVIEW", true);
    expect((await run(fixture)).results[0].outcome).toBe("review_not_saved");
    const approved = await fresh("FICTIONAL-REVIEW", true); approved.manifest.allowReviewRequired = true; await approved.publish();
    expect((await run(approved)).results[0]).toMatchObject({ outcome: "inserted", includesReviewRequired: true });
  });
});
