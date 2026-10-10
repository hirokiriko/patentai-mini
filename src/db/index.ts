import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { Pool } from "pg";
import { assertTrialDatabase, readTrialPolicy, trialConfigured, TrialError } from "../lib/trial/policy";

type Database = NodePgDatabase<typeof schema>;

let _db: Database | null = null;
let databaseBinding: string | undefined;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Postgres connection.");
  }
  return databaseUrl;
}

function getDb(): Database {
  const trial = trialConfigured();
  if (trial) assertTrialDatabase(readTrialPolicy(), getDatabaseUrl());
  const binding = JSON.stringify([trial, getDatabaseUrl()]);
  if (_db && databaseBinding !== binding) throw new TrialError();
  if (!_db) {
    databaseBinding = binding;
    if (trial) {
      const policy = readTrialPolicy(), url = new URL(getDatabaseUrl());
      const pool = new Pool({ host: policy.database.host, port: policy.database.port, database: policy.database.database,
        user: policy.database.webUser, password: decodeURIComponent(url.password), max: 2, connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000, query_timeout: 35_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000,
        ssl: { rejectUnauthorized: true }, options: "-c search_path=pg_catalog,public", application_name: "trial-web" });
      pool.on("error", () => undefined);
      _db = drizzle(pool, { schema });
      return _db;
    }
    _db = drizzle({
      connection: getDatabaseUrl(),
      schema,
    });
  }
  return _db;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
