import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { buildMinimalFictionalPackage } from "../src/lib/koho-package/__fixtures__/fictional-package";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoImportPlan } from "../src/lib/koho-import/builder";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { saveKohoImportPlan } from "../src/repositories/drizzle";
import { importApprovedPackage, validateImportConfiguration, type ImportConfiguration } from "./koho-production-import";

const base: ImportConfiguration = {
  approval: "LOCAL_IMPORT_FIRST_V1", mode: "local", fixture: true,
  connection: { host: "127.0.0.1", port: 5432, database: "koho_issue89_fixture", user: "fixture", password: "fictional" },
  expectedTarget: { host: "127.0.0.1", port: 5432, database: "koho_issue89_fixture", user: "fixture" },
  package: { name: "JPA_2026155.ZIP", path: "JPA_2026155.ZIP", type: "JPA", sha256: "a".repeat(64), bytes: 1000, documents: 1 },
};
describe("Local import admission", () => {
  it("rejects a target mismatch before reading a file", async () => {
    await expect(importApprovedPackage({ ...base, expectedTarget: { ...base.expectedTarget, database: "other" } })).rejects.toThrow("koho_import_stopped");
  });
  it("rejects remote databases in local mode", () => {
    const connection = { ...base.connection, host: "example.invalid" };
    expect(() => validateImportConfiguration({ ...base, connection, expectedTarget: connection })).toThrow();
  });
  it("rejects a production fixture and an unapproved package", () => {
    expect(() => validateImportConfiguration({ ...base, mode: "production" })).toThrow();
    expect(() => validateImportConfiguration({ ...base, package: { ...base.package, name: "other.ZIP" } })).toThrow();
  });
  it("rejects connection-string and TLS overrides at the untyped input boundary", () => {
    const connection = { ...base.connection, connectionString: "postgres://fictional.invalid/other", ssl: false };
    expect(() => validateImportConfiguration({ ...base, connection })).toThrow();
  });
});

// This suite is genuinely executed against an isolated Postgres by the Local operator.
// Its absence from CI is an explicit skip, never real-DB evidence.
describe.skipIf(!process.env.KOHO_LOCAL_DB_TEST_CONFIG)("isolated PostgreSQL import acceptance", () => {
  let admin: Client, importer: Client, directory: string;
  const configs: ImportConfiguration[] = [];
  const plans: ReturnType<typeof buildKohoImportPlan>[] = [];
  beforeAll(async () => {
    const x = JSON.parse(process.env.KOHO_LOCAL_DB_TEST_CONFIG!);
    if (x.host !== "127.0.0.1" || !/^koho_issue89_[a-z0-9]+$/.test(x.database)) throw Error("isolated_db_required");
    directory = await mkdtemp(join(tmpdir(), "koho-issue89-fictional-"));
    const connection = { host: x.host, port: x.port, database: x.database, user: "koho_import_test", password: x.import_password };
    admin = new Client({ ...connection, user: "postgres", password: x.admin_password });
    importer = new Client(connection);
    await admin.connect(); await importer.connect();
    for (const type of ["JPA", "JPB"] as const) {
      const bytes = buildMinimalFictionalPackage(type), name = `${type}_2026155.ZIP`, path = join(directory, name);
      await writeFile(path, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const { password: _password, ...expectedTarget } = connection; void _password;
      configs.push({ ...base, connection, expectedTarget,
        package: { name, path, type, bytes: bytes.length, sha256, documents: 1 } });
      plans.push(buildKohoImportPlan({ sourceSha256: sha256, packageResult: await parseKohoPackage({
        packageType: type, source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) }) }));
    }
  });
  afterAll(async () => {
    if (admin) {
      await admin.query("DROP TRIGGER IF EXISTS issue89_fixture_failure ON koho_import_documents");
      await admin.query("DROP FUNCTION IF EXISTS issue89_fixture_failure()");
      for (const plan of plans) await admin.query("DELETE FROM koho_import_runs WHERE source_sha256=$1", [plan.sourceSha256]);
      await admin.end();
    }
    if (importer) await importer.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const snapshot = async () => (await admin.query(`select row_to_json(r)::text as run,
    (select json_agg(d order by document_id)::text from koho_import_documents d where d.import_id=r.import_id) as docs
    from koho_import_runs r order by import_id`)).rows;
  it("rejects wrong bytes before any database write", async () => {
    const before = await snapshot();
    await expect(importApprovedPackage({ ...configs[0], package: { ...configs[0].package, sha256: "0".repeat(64) } })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("persists fictional JPA and JPB through the real entrypoint with least privilege", async () => {
    for (const config of configs) expect(await importApprovedPackage(config)).toMatchObject({ status: "saved", documents: 1 });
    expect((await admin.query("select count(*)::int as n from koho_import_documents")).rows[0].n).toBe(2);
    await expect(importer.query("CREATE TABLE must_not_exist(i int)")).rejects.toThrow();
  });
  it("keeps every ID, field and microsecond timestamp unchanged on same-package reuse", async () => {
    const before = await snapshot();
    for (const config of configs) await importApprovedPackage(config);
    expect(await snapshot()).toEqual(before);
  });
  it("rejects corrupted existing content without advancing the cursor", async () => {
    await admin.query("UPDATE koho_import_documents SET invention_title='Fictional corrupted value' WHERE import_id=(select import_id from koho_import_runs where source_sha256=$1)", [plans[0].sourceSha256]);
    const before = await snapshot();
    await expect(saveKohoImportPlan(drizzle(importer, { schema }), plans[0], true)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await admin.query("UPDATE koho_import_documents SET invention_title=$1 WHERE import_id=(select import_id from koho_import_runs where source_sha256=$2)", [plans[0].documents[0].inventionTitle, plans[0].sourceSha256]);
  });
  it("rolls back the entire package on a document-write fault", async () => {
    await admin.query("DELETE FROM koho_import_runs WHERE source_sha256=$1", [plans[1].sourceSha256]);
    const before = await snapshot();
    await admin.query("CREATE FUNCTION issue89_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional fault'; END $$");
    await admin.query("CREATE TRIGGER issue89_fixture_failure BEFORE INSERT ON koho_import_documents FOR EACH ROW EXECUTE FUNCTION issue89_fixture_failure()");
    try { await expect(saveKohoImportPlan(drizzle(importer, { schema }), plans[1], true)).rejects.toThrow(); }
    finally { await admin.query("DROP TRIGGER issue89_fixture_failure ON koho_import_documents"); await admin.query("DROP FUNCTION issue89_fixture_failure()"); }
    expect(await snapshot()).toEqual(before);
  });
  it("waits for the shared import/watch cursor lock and assigns a later microsecond cursor", async () => {
    await admin.query("BEGIN");
    await admin.query("select pg_advisory_xact_lock(70000001::bigint)");
    let settled = false;
    const save = saveKohoImportPlan(drizzle(importer, { schema }), plans[1], true).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await admin.query("COMMIT"); await save;
    expect((await admin.query("select count(distinct updated_at)::int as n from koho_import_runs")).rows[0].n).toBe(2);
  });
  it("rolls back an INSERT suppressed by a trigger before commit", async () => {
    await admin.query("DELETE FROM koho_import_runs WHERE source_sha256=$1", [plans[1].sourceSha256]);
    const before = await snapshot();
    await admin.query("CREATE FUNCTION issue89_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
    await admin.query("CREATE TRIGGER issue89_fixture_failure BEFORE INSERT ON koho_import_documents FOR EACH ROW EXECUTE FUNCTION issue89_fixture_failure()");
    try { await expect(saveKohoImportPlan(drizzle(importer, { schema }), plans[1], true)).rejects.toThrow("koho_saved_document_count_mismatch"); }
    finally { await admin.query("DROP TRIGGER issue89_fixture_failure ON koho_import_documents"); await admin.query("DROP FUNCTION issue89_fixture_failure()"); }
    expect(await snapshot()).toEqual(before);
  });
});
