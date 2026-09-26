import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { ManualConfiguration } from "../src/lib/koho-import/manual-cli-config";

// The isolated lifecycle follows koho-manual-import-local.test.ts. Never read .env.
export const isolatedChildEnv = () => ({ NODE_ENV: "test" as const, SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH });
const unconfirmedProcesses = new Set<ReturnType<typeof spawn>>();
export const hasUnconfirmedIsolatedProcess = () => unconfirmedProcesses.size > 0;
export async function isolatedCommand(file: string, args: string[], input = "", env: Record<string, string | undefined> = {}, timeout = 60_000, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return await new Promise<{ code: number | null; output: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(file, args, { windowsHide: true, env: { ...isolatedChildEnv(), ...env } });
    let output = "", stderr = "";
    let failure: string | undefined, exitTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      // Do not race cleanup against a still-running Docker command. Failure to
      // observe close is itself unknown and must never authorize a new create.
      exitTimer = setTimeout(() => { unconfirmedProcesses.add(child); reject(Error("isolated_process_exit_unconfirmed")); }, 5000);
      child.kill();
    };
    const timer = setTimeout(() => stop("isolated_process_timeout"), timeout);
    const abort = () => stop("isolated_process_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const done = () => { unconfirmedProcesses.delete(child); clearTimeout(timer); clearTimeout(exitTimer); signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    // A kill error (including synchronous EPERM) is not a close notification.
    child.on("error", () => { if (!failure) { done(); reject(Error("isolated_process_unavailable")); } });
    child.on("close", code => { done(); if (failure) reject(Error(failure)); else resolvePromise({ code, output, stderr }); });
    child.stdin.on("error", () => undefined); child.stdin.end(input);
  });
}
export async function isolatedPg16(issue: 101 | 103 | 123 | 125 | 129 = 101, deadline?: AbortSignal) {
  deadline?.throwIfAborted();
  if (process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1" || process.env.DATABASE_URL || process.env.PGHOST || process.env.PGSERVICE) {
    throw Error("isolated_database_opt_in_required");
  }
  const directory = await mkdtemp(join(tmpdir(), "watch-report-test-"));
  const suffix = randomBytes(8).toString("hex"), database = `koho_manual_import_test_${suffix}`;
  const container = `watch-report-test-${suffix}`, password = randomBytes(24).toString("hex");
  const clients: Client[] = []; let createAttempted = false, createAcknowledged = false;
  let cleaning = false;
  const docker = (args: string[], env: Record<string, string | undefined> = {}) => isolatedCommand("docker", ["--config", join(directory, "docker-config"), ...args], "", env,
    cleaning && deadline ? 15_000 : 60_000, cleaning ? undefined : deadline);
  const abort = () => { for (const client of clients) void client.end().catch(() => undefined); };
  deadline?.addEventListener("abort", abort, { once: true });
  const cleanup = async () => {
    cleaning = true; deadline?.removeEventListener("abort", abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all(clients.map(client => client.end().catch(() => undefined))),
      new Promise<void>(done => { timer = setTimeout(done, 3000); })]); }
    finally { clearTimeout(timer); }
    if (createAttempted) {
      const inspect = () => docker(["container", "inspect", "--format", '{{index .Config.Labels "patentai.owner"}}', container]);
      const absent = (result: Awaited<ReturnType<typeof docker>>) => result.code !== 0 && /No such (?:object|container)/i.test(result.stderr);
      const target = await inspect();
      // A cancelled create can still be finishing inside Docker. A transient
      // absence is not proof of cleanup; keep the private recovery directory.
      if (absent(target) && !createAcknowledged) throw Error("isolated_cleanup_unconfirmed");
      if (!absent(target)) {
        if (target.code !== 0 || target.output.trim() !== suffix) throw Error("isolated_cleanup_unconfirmed");
        if ((await docker(["rm", "--force", "--volumes", container])).code !== 0 || !absent(await inspect())) throw Error("isolated_cleanup_unconfirmed");
      }
    }
    // directory came only from mkdtemp, never user configuration.
    await rm(directory, { recursive: true, force: true });
  };
  let phase = "container_create";
  try {
    await mkdir(join(directory, "docker-config"));
    if (issue === 123 || issue === 125) {
      phase = "existing_runtime_preflight";
      if ((await docker(["image", "inspect", "postgres:16", "--format", "{{.Id}}"])).code !== 0) throw Error();
    }
    createAttempted = true;
    const created = await docker(["create", "--name", container, "--label", `patentai.issue=${issue}`, "--label", `patentai.owner=${suffix}`,
      "--publish", "127.0.0.1::5432", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", ...([123, 125, 129].includes(issue) ? ["--pull", "never"] : []), "postgres:16"],
    { POSTGRES_PASSWORD: password, POSTGRES_DB: database });
    if (created.code !== 0) throw Error();
    createAcknowledged = true;
    phase = "container_start";
    if ((await docker(["start", container])).code !== 0) throw Error();
    // Docker Desktop can acknowledge start before its dynamic host port is assigned.
    phase = "port_binding";
    let match: RegExpExecArray | null = null;
    for (let n = 0; n < 40; n++) {
      const binding = await docker(["port", container, "5432/tcp"]);
      if (binding.code !== 0) throw Error();
      match = /^127\.0\.0\.1:(\d+)\s*$/.exec(binding.output);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) break;
      if (binding.output.trim() && (!match || Number(match[1]) > 65535)) throw Error();
      match = null;
      await new Promise(done => setTimeout(done, 100));
    }
    if (!match) throw Error();
    const base = { host: "127.0.0.1" as const, port: Number(match[1]), database, ssl: false as const, connectionTimeoutMillis: 1000 };
    async function connect(user: string, secret: string) {
      deadline?.throwIfAborted();
      const client = new Client({ ...base, user, password: secret }); client.on("error", () => undefined);
      try { await client.connect(); clients.push(client); deadline?.throwIfAborted(); return client; }
      catch { await client.end().catch(() => undefined); throw Error("isolated_connection_failed"); }
    }
    let admin: Client | undefined;
    phase = "local_connection";
    for (let n = 0; n < 40; n++) {
      try { admin = await connect("postgres", password); break; }
      catch { await new Promise(done => setTimeout(done, 250)); }
    }
    if (!admin) throw Error();
    const sql = async (text: string, values?: unknown[]) => {
      deadline?.throwIfAborted();
      try { return (await admin!.query(text, values)).rows; }
      catch { throw Error("isolated_sql_check_failed"); }
    };
    if ((await sql("select current_setting('server_version_num')::int / 10000 as major"))[0].major !== 16) throw Error();
    phase = "existing_migrations";
    await migrate(drizzle(admin), { migrationsFolder: resolve("drizzle") });
    phase = "minimal_roles";
    await sql(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    const role = async (prefix: string) => {
      const user = `${prefix}_${suffix}`, secret = randomBytes(24).toString("hex");
      await sql(`CREATE ROLE ${user} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await sql(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
      await sql(`GRANT USAGE ON SCHEMA public TO ${user}`);
      return { user, secret };
    };
    const importer = await role("manual_import"), watcher = await role("watch_test"), reader = await role("report_test");
    await sql(`GRANT SELECT, INSERT ON koho_import_runs, koho_import_documents TO ${importer.user}`);
    await sql(`GRANT USAGE ON SEQUENCE koho_import_runs_import_id_seq, koho_import_documents_document_id_seq TO ${importer.user}`);
    // Includes fixture case/draft setup through the existing repository.
    await sql(`GRANT SELECT, INSERT ON cases, draft_patents TO ${watcher.user}`);
    await sql(`GRANT UPDATE(case_id) ON cases TO ${watcher.user}`);
    await sql(`GRANT UPDATE(extracted_claims_json) ON draft_patents TO ${watcher.user}`);
    await sql(`GRANT SELECT ON koho_import_runs, koho_import_documents TO ${watcher.user}`);
    await sql(`GRANT SELECT, INSERT, UPDATE ON case_watch_settings, case_watch_runs TO ${watcher.user}`);
    await sql(`GRANT SELECT, INSERT, UPDATE(review_status) ON case_watch_findings TO ${watcher.user}`);
    await sql(`GRANT USAGE ON SEQUENCE cases_case_id_seq, draft_patents_draft_id_seq, case_watch_settings_watch_id_seq, case_watch_runs_run_id_seq, case_watch_findings_finding_id_seq TO ${watcher.user}`);
    await sql(`GRANT SELECT ON cases, case_watch_settings, case_watch_runs, case_watch_findings TO ${reader.user}`);
    if (issue === 103 || issue === 125) await sql(`GRANT SELECT ON koho_import_runs, koho_import_documents TO ${reader.user}`);
    if (issue === 125) await sql(`GRANT SELECT, DELETE ON cases, draft_patents, prior_art_documents, search_query_sets, comparison_results TO ${watcher.user}`);
    const watchClient = await connect(watcher.user, watcher.secret), reportClient = await connect(reader.user, reader.secret);
    const connection: NonNullable<ManualConfiguration["connection"]> = { host: base.host, port: base.port, database, user: importer.user, password: importer.secret };
    return { directory, admin, sql, watchClient, reportClient, connection, cleanup };
  } catch {
    await cleanup(); throw Error(`isolated_pg16_setup_failed_${phase}`);
  }
}
