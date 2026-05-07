#!/usr/bin/env node
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnv() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf-8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

loadEnv();

const url = process.env.DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = createClient({ url, authToken });

async function columnExists(table, column) {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return res.rows.some((r) => r.name === column);
}

async function addColumn(table, column, ddl) {
  if (await columnExists(table, column)) {
    console.log(`  - ${table}.${column}: already exists, skipping`);
    return;
  }
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`  + ${table}.${column}: added`);
}

async function main() {
  console.log(`Connected to: ${url}`);
  console.log("Applying FR-07 schema additions...");

  await addColumn("cases", "base_application_mode", "base_application_mode INTEGER NOT NULL DEFAULT 0");
  await addColumn("cases", "base_application_number", "base_application_number TEXT");
  await addColumn("draft_patents", "kind", "kind TEXT NOT NULL DEFAULT 'main'");

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
