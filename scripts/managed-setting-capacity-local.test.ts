import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { addFictionalManagedOriginal } from "./managed-base.test-support";
import * as schema from "../src/db/schema";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";
import type { ManagedSettingInput } from "../src/lib/patent-watch/managed-types";

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1")("managed setting capacity isolated PG16", () => {
  let environment: Awaited<ReturnType<typeof isolatedPg16>>;
  let pool: Pool;
  beforeAll(async () => {
    environment = await isolatedPg16(140);
    const user = environment.connection.user;
    if (!/^manual_import_[a-f0-9]{16}$/.test(user)) throw Error("fictional_role_mismatch");
    await environment.sql(`grant select,insert,update on cases,prior_art_documents,managed_watch_settings,managed_watch_runs to ${user}`);
    await environment.sql(`grant select on managed_watch_findings,managed_watch_deliveries to ${user}`);
    await environment.sql(`grant usage on sequence managed_watch_settings_setting_id_seq to ${user}`);
    pool = new Pool({ ...environment.connection, ssl: false, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  }, 120_000);
  afterAll(async () => { await pool?.end(); await environment?.cleanup(); }, 60_000);

  it("retains disabled history while enforcing five enabled settings and serializing the last slot", async () => {
    const originals = new Map<string, Buffer>();
    const repository = new ManagedWatchRepository(drizzle(pool, { schema }), async (_caseId, _category, name) => {
      const bytes = originals.get(name); if (!bytes) throw Error("fictional_original_missing");
      return { bytes, contentType: "application/xml" };
    });
    const inputs: ManagedSettingInput[] = [];
    for (let n = 0; n < 7; n++) {
      const caseId = (await environment.sql("insert into cases(title) values ('FICTIONAL CAPACITY') returning case_id"))[0].case_id as number;
      const original = await addFictionalManagedOriginal(caseId, environment.sql, originals);
      inputs.push({ caseId, contractSignedOn: "2026-08-25", monitoringStartsOn: "2026-08-26", contractEndsOn: null,
        enabled: true, source: original.source,
        base: { ...original.base, claims: original.base.claims.map(claim => ({ ...claim, dependsOn: [...claim.dependsOn] })) },
        selectedClaimNos: [1] });
    }
    const enabledCount = async () => (await environment.sql("select count(*)::int as n from managed_watch_settings where enabled"))[0].n;
    for (const input of inputs.slice(0, 5)) await repository.saveSetting(input);
    const first = (await repository.setting(inputs[0].caseId))!;
    const snapshot = { schema: 1, setting: first, period: { from: "2026-08-26", to: "2026-09-25" },
      sourceKeys: [], candidates: [], scannedDocuments: 0, incompleteDocuments: 0, sourceBytes: 0 };
    const runId = randomUUID();
    await environment.sql("insert into managed_watch_runs(run_id,setting_id,case_id,status,period_from,period_to,base_digest,snapshot_json,snapshot_digest,source_document_id) values($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9)",
      [runId, first.settingId, first.caseId, snapshot.period.from, snapshot.period.to, first.baseDigest, JSON.stringify(snapshot), managedDigest(snapshot), first.source.documentId]);
    const retained = async () => ({
      run: await environment.sql("select row_to_json(r) as row from managed_watch_runs r where run_id=$1", [runId]),
      originals: await environment.sql("select row_to_json(d) as row from prior_art_documents d order by doc_id"),
      blobs: [...originals].map(([name, bytes]) => [name, bytes.toString("base64")]),
    });
    const before = await retained();
    await expect(repository.saveSetting(inputs[5])).rejects.toThrow("limit");
    expect((await repository.saveSetting({ ...inputs[5], enabled: false })).enabled).toBe(false);
    await expect(repository.saveSetting(inputs[5])).rejects.toThrow("limit");
    expect((await repository.saveSetting(inputs[1])).enabled).toBe(true);
    expect(await enabledCount()).toBe(5);

    await repository.saveSetting({ ...inputs[0], enabled: false });
    await repository.saveSetting(inputs[5]);
    expect(await enabledCount()).toBe(5);
    expect((await repository.setting(inputs[0].caseId))?.settingId).toBe(first.settingId);
    expect(await retained()).toEqual(before);
    await expect(repository.saveSetting(inputs[0])).rejects.toThrow("limit");

    await environment.sql("update managed_watch_runs set status='prepared' where run_id=$1", [runId]);
    await expect(repository.saveSetting({ ...inputs[0], enabled: false })).rejects.toThrow("in_progress");
    await environment.sql("update managed_watch_runs set status='completed' where run_id=$1", [runId]);
    await repository.saveSetting({ ...inputs[2], enabled: false });
    const results = await Promise.allSettled([repository.saveSetting(inputs[0]), repository.saveSetting(inputs[6])]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected").map(r => r.reason.message)).toEqual(["limit"]);
    expect(await enabledCount()).toBe(5);
    expect(await retained()).toEqual(before);
  }, 60_000);
});
