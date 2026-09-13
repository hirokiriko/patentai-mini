/** Local administrator only. Read the approved configuration from a private pipe. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoImportPlan } from "../src/lib/koho-import/builder";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { saveKohoImportPlan } from "../src/repositories/drizzle";

export interface ImportConfiguration {
  approval: "LOCAL_IMPORT_FIRST_V1";
  mode: "local" | "production";
  connection: { host: string; port: number; database: string; user: string; password: string };
  expectedTarget: { host: string; port: number; database: string; user: string };
  package: { name: string; type: "JPA" | "JPB"; path: string; bytes: number; sha256: string; documents: number };
  fixture?: boolean;
}

export class ImportStopped extends Error {
  constructor() { super("koho_import_stopped"); }
}
function requireCondition(value: unknown): asserts value {
  if (!value) throw new ImportStopped();
}

export function validateImportConfiguration(config: ImportConfiguration) {
  requireCondition(config?.approval === "LOCAL_IMPORT_FIRST_V1");
  const { connection: c, expectedTarget: t, package: p } = config;
  requireCondition(c && t && p && (config.mode === "local" || config.mode === "production"));
  requireCondition(Object.keys(c).sort().join() === "database,host,password,port,user" &&
    Object.keys(t).sort().join() === "database,host,port,user");
  requireCondition([c.host, c.database, c.user, c.password].every(v => typeof v === "string" && v.length > 0));
  requireCondition(["host", "port", "database", "user"].every(k =>
    c[k as keyof typeof t] === t[k as keyof typeof t]));
  requireCondition(Number.isInteger(c.port) && c.port > 0 && c.port <= 65535 && c.password && c.database && c.user);
  if (config.mode === "local") {
    requireCondition((c.host === "127.0.0.1" || c.host === "::1") && /^koho_issue89_[a-z0-9_]+$/.test(c.database));
  } else {
    requireCondition(/^[a-z0-9-]+\.postgres\.database\.azure\.com$/.test(c.host) && c.port === 5432 && !config.fixture);
  }
  requireCondition(p.type === "JPA" || p.type === "JPB");
  requireCondition(p.name === `${p.type}_2026155.ZIP` && basename(p.path) === p.name);
  requireCondition(Number.isSafeInteger(p.bytes) && p.bytes > 0 && p.bytes <= 8 * 1024 ** 3);
  requireCondition(/^[a-f0-9]{64}$/.test(p.sha256));
  requireCondition(p.documents === (config.fixture ? 1 : p.type === "JPA" ? 1048 : 580));
}

async function digest(path: string, maxBytes: number) {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length; requireCondition(size <= maxBytes); hash.update(chunk);
  }
  requireCondition(size === maxBytes);
  return hash.digest("hex");
}

export async function importApprovedPackage(config: ImportConfiguration) {
  validateImportConfiguration(config);
  const original = await lstat(config.package.path);
  requireCondition(original.isFile() && !original.isSymbolicLink() && original.size === config.package.bytes);
  // The operator's input directory is owner-only (including its Windows ACL).
  // Parse an exclusively created snapshot, never a repeatedly reopened source path.
  const parent = resolve(dirname(config.package.path));
  const directory = await mkdtemp(join(parent, ".koho-verify-"));
  requireCondition(dirname(directory) === parent);
  try {
    const snapshot = join(directory, config.package.name);
    let copied = 0;
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      copied += chunk.length;
      if (copied > config.package.bytes) callback(new ImportStopped());
      else callback(null, chunk);
    } });
    await pipeline(createReadStream(config.package.path), bounded, createWriteStream(snapshot, { flags: "wx", mode: 0o600 }));
    requireCondition(copied === config.package.bytes);
    return await importSnapshot({ ...config, package: { ...config.package, path: snapshot } });
  } finally {
    // Exact child created above; original inputs and neighbouring files are untouched.
    await rm(directory, { recursive: true, force: true });
  }
}

async function importSnapshot(config: ImportConfiguration) {
  const started = performance.now(); const p = config.package;
  const initial = await lstat(p.path);
  requireCondition(initial.isFile() && !initial.isSymbolicLink() && initial.size === p.bytes);
  requireCondition(await digest(p.path, p.bytes) === p.sha256);
  const result = await parseKohoPackage({ packageType: p.type,
    source: { type: "file", path: p.path }, limits: buildKohoManualImportLimits(p.bytes) });
  const plan = buildKohoImportPlan({ packageResult: result, sourceSha256: p.sha256 });
  requireCondition(plan.packageStatus !== "failed" && plan.documentCount === p.documents);
  const current = await lstat(p.path);
  requireCondition(current.isFile() && !current.isSymbolicLink() && current.size === initial.size &&
    current.mtimeMs === initial.mtimeMs && current.ino === initial.ino);
  // Bind what was parsed to the approved bytes before any DB connection/write.
  requireCondition(await digest(p.path, p.bytes) === p.sha256);
  requireCondition(performance.now() - started < 115 * 60_000);
  const c = config.connection;
  const client = new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: config.mode === "production" ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 30_000, statement_timeout: 120_000, lock_timeout: 30_000,
    options: "-c search_path=pg_catalog,public",
    application_name: "koho-issue89-import",
  });
  let connectionFailed = false;
  const onConnectionError = () => { connectionFailed = true; };
  client.on("error", onConnectionError);
  try {
    await client.connect();
    const identity = (await client.query(`select current_database() as db, current_user as usr,
      current_setting('server_version_num')::int / 10000 as major,
      pg_is_in_recovery() as recovery, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles where rolname = current_user`)).rows[0];
    requireCondition(identity.db === config.expectedTarget.database && identity.usr === config.expectedTarget.user &&
      identity.major === 16 && !identity.recovery && !identity.rolsuper && !identity.rolcreatedb &&
      !identity.rolcreaterole && !identity.rolreplication && !identity.rolbypassrls);
    if (config.mode === "production") {
      requireCondition((await client.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()")).rows[0]?.ssl === true);
    }
    const before = (await client.query("select pg_database_size(current_database())::text as bytes, pg_current_wal_lsn()::text as lsn")).rows[0];
    requireCondition(!connectionFailed);
    const saved = await saveKohoImportPlan(drizzle(client, { schema }), plan, true);
    requireCondition(saved.savedDocumentCount === p.documents);
    const after = (await client.query("select pg_database_size(current_database())::text as bytes, pg_wal_lsn_diff(pg_current_wal_lsn(), $1)::text as wal", [before.lsn])).rows[0];
    requireCondition(!connectionFailed);
    return { status: "saved", packageType: p.type, packageStatus: plan.packageStatus,
      documents: saved.savedDocumentCount, amendments: plan.amendmentCount, nestedSt26: plan.nestedSt26Count,
      reviewDocuments: plan.documents.filter(d => d.parseStatus === "review_required").length,
      elapsedMs: Math.ceil(performance.now() - started), peakRssKiB: process.resourceUsage().maxRSS,
      databaseGrowthBytes: Number(after.bytes) - Number(before.bytes), walBytes: Number(after.wal) };
  } finally {
    await client.end().catch(() => {});
    client.removeListener("error", onConnectionError);
  }
}

if (require.main === module) {
  const watchdog = setTimeout(() => { process.stdout.write('{"status":"timeout_reconcile_required"}\n'); process.exit(2); }, 120 * 60_000);
  const inputDeadline = setTimeout(() => { process.stdout.write('{"status":"input_timeout"}\n'); process.exit(2); }, 10_000);
  void (async () => {
    try {
      let input = "";
      for await (const chunk of process.stdin) { input += chunk; requireCondition(Buffer.byteLength(input) <= 32_768); }
      clearTimeout(inputDeadline);
      const value = await importApprovedPackage(JSON.parse(input));
      process.stdout.write(JSON.stringify(value) + "\n");
    } catch { process.stdout.write('{"status":"failed_reconcile_required"}\n'); process.exitCode = 1; }
    finally { clearTimeout(watchdog); clearTimeout(inputDeadline); }
  })();
}
