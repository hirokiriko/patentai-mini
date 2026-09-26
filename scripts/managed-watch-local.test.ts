import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { manualFixture } from "./koho-manual-import-fixtures";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { buildKohoImportPlan } from "../src/lib/koho-import/builder";
import { projectManagedClaimSource } from "../src/lib/koho-import/managed-claim-source";
import { saveKohoImportPlan } from "../src/repositories/drizzle";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";
import * as schema from "../src/db/schema";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { managedScreeningInput } from "../src/lib/patent-watch/managed-types";
import { projectManagedPackageReceipt } from "../src/lib/koho-import/managed-package-receipt";
import { ManagedDeliveryRepository } from "../src/repositories/managed-delivery";
import { MANAGED_DISTRIBUTION_URL } from "../src/lib/patent-watch/managed-distribution";
import { DISTRIBUTION_HEADERS } from "../src/lib/koho-distribution-table";
import type { ManagedDelivery } from "../src/lib/patent-watch/managed-delivery";
import { ManagedCloudStartRepository } from "../src/repositories/managed-cloud-start";
import { managedCloudFixture } from "../src/lib/patent-watch/managed-cloud.test-support";
import { managedBudgetedWatchFixture } from "../src/lib/patent-watch/managed-execution-budget.test-support";
import { managedCloudConfigSchema } from "../src/lib/patent-watch/managed-cloud-config";
import { managedDeadlineDatabase } from "../src/lib/patent-watch/managed-request-db";
import { addFictionalManagedOriginal } from "./managed-base.test-support";

const aiBudget = { inputYenPerMillion: 500, outputYenPerMillion: 3000, maximumYen: 30_000 };
describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1")("managed watch isolated PG16", () => {
  let environment: Awaited<ReturnType<typeof isolatedPg16>>;
  let importer: Client;
  const originals=new Map<string,Buffer>();
  const readOriginal=async(_caseId:number,_category:string,name:string)=>{const bytes=originals.get(name);if(!bytes)throw Error();return{bytes,contentType:"application/xml"};};
  beforeAll(async () => {
    environment = await isolatedPg16(129);
    importer = new Client({ ...environment.connection, ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 20000, query_timeout: 22000 });
    importer.on("error", () => undefined); await importer.connect();
    const watcher=(await environment.watchClient.query("select current_user as name")).rows[0].name as string;
    if(!/^watch_test_[a-f0-9]{16}$/.test(watcher))throw Error("fictional_role_mismatch");
    await environment.sql(`grant select,update on prior_art_documents to ${watcher}`);
  }, 120_000);
  afterAll(async () => { await importer?.end(); await environment?.cleanup(); }, 60_000);
  it("saves 4000 documents below the bind limit and rolls back earlier chunks when a later chunk fails", async () => {
    const bytes = manualFixture("JPA", 4000, { publicationDate: "2099-03-11", issue: "FICTIONAL-LARGE-BATCH" });
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes },
      limits: buildKohoManualImportLimits(bytes.length) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256 });
    expect(plan.documentCount).toBe(4000);
    const database = drizzle(importer, { schema });
    await environment.sql("alter table koho_import_documents add constraint fictional_late_batch check (publication_number <> '2099003601')");
    try {
      await expect(saveKohoImportPlan(database, plan, true, "inserted")).rejects.toThrow();
      expect((await environment.sql("select count(*)::int as n from koho_import_runs where source_sha256=$1", [sourceSha256]))[0].n).toBe(0);
      expect((await environment.sql("select count(*)::int as n from koho_import_documents"))[0].n).toBe(0);
    } finally {
      await environment.sql("alter table koho_import_documents drop constraint fictional_late_batch");
    }
    try {
      expect((await saveKohoImportPlan(database, plan, true, "inserted")).savedDocumentCount).toBe(4000);
      expect((await environment.sql("select count(*)::int as n from koho_import_documents d join koho_import_runs r using(import_id) where r.source_sha256=$1", [sourceSha256]))[0].n).toBe(4000);
    } finally {
      await environment.sql("delete from koho_import_runs where source_sha256=$1", [sourceSha256]);
    }
  // The 4,000-document parser/rollback fixture can exceed a minute on the
  // Windows Local runner. This test bound does not change any production deadline.
  }, 180_000);
  it("cancels a real server query at the request deadline and rolls back the transaction",async()=>{
    const database=managedDeadlineDatabase(environment.watchClient,250),started=Date.now();
    await expect(database.transaction(async tx=>{await tx.execute(sql`select pg_sleep(5)`);})).rejects.toThrow();
    expect(Date.now()-started).toBeLessThan(4000);
    expect((await environment.watchClient.query("select 1 as n")).rows[0].n).toBe(1);
    await expect(database.execute(sql`select 1`)).rejects.toThrow();
  });
  it("uses every official period row, immutable package receipts and stored versions to prove a complete delivery", async () => {
    const watcher = (await environment.watchClient.query("select current_user as name")).rows[0].name as string;
    if (!/^watch_test_[a-f0-9]{16}$/.test(watcher)) throw Error("fictional_role_mismatch");
    await environment.sql(`GRANT SELECT, INSERT, UPDATE ON managed_watch_settings, managed_watch_runs, managed_watch_dispatches, managed_watch_findings, managed_watch_deliveries, managed_watch_job_starts TO ${watcher}`);
    await environment.sql(`GRANT SELECT ON managed_publication_claims, managed_import_receipts, managed_distribution_snapshots TO ${watcher}`);
    await environment.sql(`GRANT USAGE ON SEQUENCE managed_watch_settings_setting_id_seq, managed_watch_dispatches_dispatch_id_seq, managed_watch_findings_finding_id_seq TO ${watcher}`);
    await environment.sql(`GRANT SELECT, INSERT ON managed_publication_claims, managed_import_receipts TO ${environment.connection.user}`);
    const caseId = (await environment.sql("insert into cases(title) values ('FICTIONAL DELIVERY PROOF') returning case_id"))[0].case_id as number;
    const database = drizzle(environment.watchClient, { schema }), repository = new ManagedWatchRepository(database,readOriginal), deliveries = new ManagedDeliveryRepository(database);
    const add = async (date: string, issue: string, control: string) => {
      const bytes = manualFixture("JPA", 1, { publicationDate: date, issue, control, claims: [{ number: "1", text: "完全架空の記録検出装置。" }] });
      const sha = createHash("sha256").update(bytes).digest("hex"), parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) });
      const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: sha }), receipt = projectManagedPackageReceipt(parsed, plan);
      const sources = plan.documents.map(stored => {
        const r = parsed.primaryXmlResults.find(r=>r.normalizedPath===stored.normalizedEntryPath)!.result;
        if (!("document" in r) || !r.document) throw Error("fixture"); return projectManagedClaimSource(r.document, stored, sha);
      });
      await saveKohoImportPlan(drizzle(importer, { schema }), plan, true, "inserted", sources, receipt);
      expect((await saveKohoImportPlan(drizzle(importer, { schema }), plan, true, "reused", sources, receipt)).disposition).toBe("reused");
      return JSON.parse(sources[0].claimsJson!);
    };
    const base = await add("2026-08-12", "2026-148", "01115"), period = { from: "2026-07-26", to: "2026-08-25" };
    const original=await addFictionalManagedOriginal(caseId,environment.sql,originals,base);
    const changed=await addFictionalManagedOriginal(caseId,environment.sql,originals,{...base,claims:base.claims.map((c:{text:string})=>({...c,text:c.text+"別版の架空条件。"}))});
    const input = { caseId, contractSignedOn: "2026-07-25", monitoringStartsOn: period.from, contractEndsOn: null, enabled: true, base,source:original.source, selectedClaimNos: [1] };
    await repository.saveSetting(input);
    await expect(environment.sql("delete from prior_art_documents where doc_id=$1",[original.source.documentId])).rejects.toThrow("isolated_sql_check_failed");
    const row = (date: string, issue: string, cumulative: string) => [date, issue, cumulative, "000101", "000101", "", "", "00001", "00000", "可", ""].join(",");
    const csvText = [DISTRIBUTION_HEADERS.JPA.join(","), row("20260724", "136", "01103"), row("20260812", "148", "01115"), row("20260813", "149", "01116"), row("20260826", "158", "01125")].join("\r\n")+"\r\n";
    const sha = createHash("sha256").update(csvText).digest("hex");
    await environment.sql("insert into managed_distribution_snapshots(sha256,source_url,csv_text,acquired_at) values($1,$2,$3,$4)", [sha, MANAGED_DISTRIBUTION_URL, csvText, "2026-09-22T00:00:00Z"]);
    const starts = new ManagedCloudStartRepository(database), operationIds: string[] = [], historicalStandard:string[]=[];
    const complete = async () => {
      const prepared = await repository.prepare(caseId, period), config = managedBudgetedWatchFixture({...managedCloudFixture(caseId,prepared.runId,prepared.snapshotDigest),operationId:randomUUID(),
        ...(operationIds.length === 1 ? { caseAllowList: [caseId, 9901] } : {}),
        approval:operationIds.length===1?"STANDARD_MANAGED_WATCH_STANDARD_V1":"STANDARD_MANAGED_WATCH_RELEASE_V1"}).config;
      if(operationIds.length===0){
        const seed=async(standard:boolean,count:number)=>{
          const ids:string[]=[];
          for(let n=0;n<count;n++){
            const c=managedCloudConfigSchema.parse({...config,operationId:randomUUID(),approval:standard?"STANDARD_MANAGED_WATCH_STANDARD_V1":config.approval,
              serviceBudget:{...config.serviceBudget,profileDigest:standard?"d".repeat(64):null}});
            await environment.sql("insert into managed_watch_job_starts(operation_id,config_json,config_digest,logical_starts,reserved_normal,reserved_minutes,status,created_at) values($1,$2,$3,1,0,95,'completed','2026-08-01T00:00:00Z')",
              [c.operationId,JSON.stringify(c),managedDigest(c)]);ids.push(c.operationId);
          }return ids;
        };
        // An older Standard month's 25 rows must not exhaust the release's
        // separate cumulative cap. Its 24 release rows still do, across months.
        historicalStandard.push(...await seed(true,25));const release=await seed(false,24);
        await expect(starts.reserve(config)).rejects.toThrow("conflict");
        await environment.sql("delete from managed_watch_job_starts where operation_id=any($1::text[])",[release]);
        const bad=managedBudgetedWatchFixture({...config,operationId:randomUUID(),caseAllowList:[caseId,9876],
          runs:[...config.runs,{caseId:9876,runId:randomUUID(),snapshotDigest:"f".repeat(64)}]}).config;
        await expect(starts.reserve(bad)).rejects.toThrow("conflict");
        expect((await environment.sql("select start_reservation_id from managed_watch_runs where run_id=$1",[prepared.runId]))[0].start_reservation_id).toBeNull();
        await starts.reserve(config);operationIds.push(config.operationId);
      }else{
        if(config.approval === "STANDARD_MANAGED_WATCH_STANDARD_V1") {
          const release = managedBudgetedWatchFixture({ ...config, operationId: randomUUID(),
            approval: "STANDARD_MANAGED_WATCH_RELEASE_V1", caseAllowList: [caseId, 9002, 9003, 9004, 9005] }).config;
          await environment.sql("insert into managed_watch_job_starts(operation_id,config_json,config_digest,logical_starts,reserved_normal,reserved_minutes,status) values($1,$2,$3,1,0,95,'completed')",
            [release.operationId, JSON.stringify(release), managedDigest(release)]);
          historicalStandard.push(release.operationId);
          const sixthRelease = managedBudgetedWatchFixture({ ...config, approval: "STANDARD_MANAGED_WATCH_RELEASE_V1" }).config;
          await expect(starts.reserve(sixthRelease)).rejects.toThrow("conflict");
          expect((await environment.sql("select start_reservation_id from managed_watch_runs where run_id=$1", [prepared.runId]))[0].start_reservation_id).toBeNull();
        }
        await starts.reserve(config);operationIds.push(config.operationId);
        if(config.approval==="STANDARD_MANAGED_WATCH_STANDARD_V1")await environment.sql("delete from managed_watch_job_starts where operation_id=any($1::text[])",[historicalStandard]);}
      await expect(starts.reserve({...config,operationId:randomUUID()})).rejects.toThrow("conflict");
      await expect(repository.claim(caseId,prepared.runId,"fictional-worker")).rejects.toThrow("conflict");
      await starts.submitting(config);
      const execution=`fictional-manual-${prepared.runId}`, proof={operationId:config.operationId,snapshotDigest:prepared.snapshotDigest};
      const run=await repository.claim(caseId,prepared.runId,execution,proof);
      if (run.snapshot.candidates.length) {
        const journal = repository.journal(run, "screening", null, managedDigest(managedScreeningInput(run.snapshot)), aiBudget);
        await journal.reserve({ ordinal: 1, requestSha256: "c".repeat(64), estimatedInputTokens: 100, maximumOutputTokens: 8192 });
        await journal.reconcile({ ordinal: 1, inputTokens: 30, outputTokens: 20 });
        run.plan = await repository.saveScreening(run, []);
      }
      await repository.finalize(run);
      expect(await starts.finish(config,execution)).toBe(true);
      expect((await starts.get(config.operationId)).status).toBe("completed");
    };
    const stored = async (report: ManagedDelivery) => {
      const manifest = { schema: 1 as const, caseId, deliveryId: report.deliveryId, artifacts: (["snapshot","pdf","csv"] as const).map(kind=>({kind, sha256:"e".repeat(64), bytes:20})) };
      await deliveries.reserveArtifacts(report, manifest); await deliveries.markArtifacts(report, manifest, "stored");
    };
    await complete();
    await expect(deliveries.prepare(caseId, period, { distributionTableSha256: sha, packages: [] }, "initial")).rejects.toThrow();
    const first = await deliveries.prepare(caseId, period, { distributionTableSha256: sha }, "initial");
    await expect(deliveries.prepare(caseId,period,{distributionTableSha256:sha},"initial",null,first.deliveryId)).rejects.toThrow("conflict");
    await expect(deliveries.abandonPreparation(caseId,first.deliveryId)).rejects.toThrow("conflict");
    expect(first.coverage).toMatchObject({ expectedPackages: 2, availablePackages: 1, complete: false }); await stored(first);
    await expect(repository.saveSetting({ ...input, base:changed.base,source:changed.source })).rejects.toThrow("conflict");
    await add("2026-08-13", "2026-149", "01116"); await complete();
    const second = await deliveries.prepare(caseId, period, { distributionTableSha256: sha }, "late_publication");
    expect(second.coverage).toMatchObject({ expectedPackages: 2, availablePackages: 2, importedDocuments: 2, complete: true });
    expect(second.previousDeliveryId).toBe(first.deliveryId); expect(second.version).toBe(2); await stored(second);
    expect((await deliveries.get(caseId, first.deliveryId)).report).toEqual(first);
    const temporary=await deliveries.prepare(caseId,period,{distributionTableSha256:sha},"review_update");
    const reservation={schema:1 as const,caseId,deliveryId:temporary.deliveryId,artifacts:(["snapshot","pdf","csv"] as const).map(kind=>({kind,sha256:"e".repeat(64),bytes:20}))};
    await deliveries.reserveArtifacts(temporary,reservation);
    await expect(deliveries.markArtifacts(temporary,reservation,"abandoned")).rejects.toThrow("incomplete");
    await environment.sql("update managed_watch_deliveries set created_at=now()-interval '11 minutes' where delivery_id=$1",[temporary.deliveryId]);
    await deliveries.markArtifacts(temporary,reservation,"abandoned");
    await expect(deliveries.reserveArtifacts(temporary,reservation)).rejects.toThrow();
    const empty=await deliveries.prepare(caseId,period,{distributionTableSha256:sha},"review_update");
    await environment.sql("update managed_watch_deliveries set created_at=now()-interval '11 minutes' where delivery_id=$1",[empty.deliveryId]);
    await deliveries.abandonPreparation(caseId,empty.deliveryId);
    await expect(deliveries.prepare(caseId, {from:"2026-08-03",to:period.to}, {distributionTableSha256:sha}, "initial")).rejects.toThrow("incomplete");
    // A receipt cannot prove rows still exist. Restore this isolated fixture after the check.
    const originalDocument = (await environment.sql("select to_jsonb(d) as row from koho_import_documents d where publication_date='2026-08-12'"))[0].row;
    const originalClaim = (await environment.sql("select to_jsonb(m) as row from managed_publication_claims m where document_id=$1",[originalDocument.document_id]))[0].row;
    await environment.sql("delete from koho_import_documents where document_id=$1",[originalDocument.document_id]);
    await expect(deliveries.prepare(caseId, period, {distributionTableSha256:sha}, "correction")).rejects.toThrow("incomplete");
    await environment.sql("insert into koho_import_documents select * from jsonb_populate_record(null::koho_import_documents,$1::jsonb)",[JSON.stringify(originalDocument)]);
    await environment.sql("insert into managed_publication_claims select * from jsonb_populate_record(null::managed_publication_claims,$1::jsonb)",[JSON.stringify(originalClaim)]);
    const otherCase = (await environment.sql("insert into cases(title) values('FICTIONAL SCOPE TEST') returning case_id"))[0].case_id;
    const oldRun = (await environment.sql("select run_id,snapshot_json,snapshot_digest from managed_watch_runs where case_id=$1 order by created_at limit 1",[caseId]))[0];
    const changedSnapshot = JSON.parse(oldRun.snapshot_json); changedSnapshot.setting.caseId = otherCase;
    await environment.sql("update managed_watch_runs set case_id=$1,snapshot_json=$2,snapshot_digest=$3 where run_id=$4",[otherCase,JSON.stringify(changedSnapshot),managedDigest(changedSnapshot),oldRun.run_id]);
    await expect(deliveries.prepare(caseId, period, {distributionTableSha256:sha}, "correction")).rejects.toThrow("incomplete");
    await expect(repository.prepare(caseId,period)).rejects.toThrow("incomplete");
    await environment.sql("update managed_watch_runs set case_id=$1,snapshot_json=$2,snapshot_digest=$3 where run_id=$4",[caseId,oldRun.snapshot_json,oldRun.snapshot_digest,oldRun.run_id]);
    await environment.sql("delete from cases where case_id=$1",[otherCase]);
    await repository.saveSetting({ ...input, base:changed.base,source:changed.source });
    // Even after switching the current base, old run snapshots retain the original.
    await expect(environment.sql("delete from prior_art_documents where doc_id=$1",[original.source.documentId])).rejects.toThrow("isolated_sql_check_failed");
    await expect(deliveries.get(caseId+999, first.deliveryId)).rejects.toThrow("not_found");
    // These grants are isolated test roles only. Restore the permission-negative test below.
    await environment.sql(`REVOKE ALL ON managed_publication_claims FROM ${environment.connection.user}`);
    await environment.sql("delete from managed_watch_deliveries where case_id=$1", [caseId]);
    await environment.sql("delete from managed_watch_settings where case_id=$1", [caseId]);
    await environment.sql("delete from prior_art_documents where case_id=$1", [caseId]);
    await environment.sql("delete from cases where case_id=$1", [caseId]);
    for(const id of operationIds)expect((await starts.get(id)).status).toBe("completed");
    await environment.sql("delete from koho_import_runs where source_sha256 in (select source_sha256 from managed_import_receipts)");
  }, 30_000);
  it("atomically persists corpus and numbered-claims metadata, preserving old immutable rows on reuse and failure", async () => {
    const bytes = manualFixture("JPA", 1);
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256 });
    expect(plan.documents).toHaveLength(1);
    const sources = plan.documents.map(stored => {
      const match = parsed.primaryXmlResults.find(item => item.normalizedPath === stored.normalizedEntryPath)?.result;
      if (!match || !("document" in match) || !match.document) throw Error("fictional_source_missing");
      return projectManagedClaimSource(match.document, stored, sourceSha256);
    });
    const database = drizzle(importer, { schema });
    // Missing new table permission fails the complete transaction, leaving no partial corpus.
    await expect(saveKohoImportPlan(database, plan, true, "inserted", sources)).rejects.toThrow();
    expect((await environment.sql("select count(*)::int as n from koho_import_documents"))[0].n).toBe(0);
    await environment.sql(`GRANT SELECT, INSERT ON managed_publication_claims TO ${environment.connection.user}`);
    const first = await saveKohoImportPlan(database, plan, true, "inserted", sources);
    expect(first.savedDocumentCount).toBe(1);
    const before = await environment.sql("select row_to_json(d)::text as document from koho_import_documents d order by document_id");
    const sidecarBefore = await environment.sql("select row_to_json(c)::text as claim from managed_publication_claims c order by document_id");
    expect(sidecarBefore).toHaveLength(1);
    const reused = await saveKohoImportPlan(database, plan, true, "reused", sources);
    expect(reused.disposition).toBe("reused");
    expect(await environment.sql("select row_to_json(d)::text as document from koho_import_documents d order by document_id")).toEqual(before);
    expect(await environment.sql("select row_to_json(c)::text as claim from managed_publication_claims c order by document_id")).toEqual(sidecarBefore);
    // A different metadata version cannot silently overwrite the stored numbered claim set.
    const changed = structuredClone(sources);
    if (changed[0].claimsJson) {
      const source = JSON.parse(changed[0].claimsJson); source.claims.at(-1).claimNo = 999;
      changed[0] = { ...changed[0], claimsJson: JSON.stringify(source), claimsDigest: managedDigest({ schema: 1, source }) };
    } else changed[0] = { ...changed[0], reason: changed[0].reason === "claims_invalid" ? "reference_missing" : "claims_invalid" };
    await expect(saveKohoImportPlan(database, plan, true, "reused", changed)).rejects.toThrow();
    expect(await environment.sql("select row_to_json(c)::text as claim from managed_publication_claims c order by document_id")).toEqual(sidecarBefore);
    // Old caller remains usable after additive migration without acquiring managed permissions.
    await environment.sql(`REVOKE ALL ON managed_publication_claims FROM ${environment.connection.user}`);
    expect((await saveKohoImportPlan(database, plan, true, "reused")).disposition).toBe("reused");
    expect((await environment.sql("select count(*)::int as n from koho_import_documents"))[0].n).toBe(1);
  }, 30_000);
  it("keeps period/source identity and atomic finalization through late imports, duplicate starts, unknown sends and restart", async () => {
    const watcher = (await environment.watchClient.query("select current_user as name")).rows[0].name as string;
    if (!/^watch_test_[a-f0-9]{16}$/.test(watcher)) throw Error("fictional_role_mismatch");
    await environment.sql(`GRANT SELECT, INSERT, UPDATE ON managed_watch_settings, managed_watch_runs, managed_watch_dispatches, managed_watch_findings TO ${watcher}`);
    await environment.sql(`GRANT SELECT ON managed_publication_claims TO ${watcher}`);
    await environment.sql(`GRANT USAGE ON SEQUENCE managed_watch_settings_setting_id_seq, managed_watch_dispatches_dispatch_id_seq, managed_watch_findings_finding_id_seq TO ${watcher}`);
    await environment.sql(`GRANT SELECT, INSERT ON managed_publication_claims TO ${environment.connection.user}`);
    const repository = new ManagedWatchRepository(drizzle(environment.watchClient, { schema }),readOriginal);
    const addPackage = async (date: string, issue: string, changed = false) => {
      const bytes = manualFixture("JPA", 1, { publicationDate: date, issue, changed, claims: [
        { number: "1", text: "完全架空の月面検出装置を構成する部材。".repeat(150) + "全文末尾の重要な架空条件。" },
        { number: "2", text: "請求項1に記載の架空装置。" },
      ] });
      const sha = createHash("sha256").update(bytes).digest("hex");
      const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) });
      const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: sha });
      const sources = plan.documents.map(stored => {
        const result = parsed.primaryXmlResults.find(p => p.normalizedPath === stored.normalizedEntryPath)!.result;
        if (!("document" in result) || !result.document) throw Error("fixture_missing");
        return projectManagedClaimSource(result.document, stored, sha);
      });
      await saveKohoImportPlan(drizzle(importer, { schema }), plan, true, "inserted", sources);
      return sources;
    };
    const sources = await addPackage("2026-08-12", "FICTIONAL-GROUP-1");
    const base = JSON.parse(sources[0].claimsJson!);
    const c1 = (await environment.sql("insert into cases(title) values ('FICTIONAL MANAGED ONE') returning case_id"))[0].case_id as number;
    const c2 = (await environment.sql("insert into cases(title) values ('FICTIONAL MANAGED TWO') returning case_id"))[0].case_id as number;
    const original1=await addFictionalManagedOriginal(c1,environment.sql,originals,base),original2=await addFictionalManagedOriginal(c2,environment.sql,originals,base);
    const input = { caseId: c1, contractSignedOn: "2026-07-25", monitoringStartsOn: "2026-07-26", contractEndsOn: null, enabled: true,
      base,source:original1.source, selectedClaimNos: [base.claims[0].claimNo] };
    const setting = await repository.saveSetting(input);
    const other = await repository.saveSetting({ ...input, caseId: c2,source:original2.source });
    const period = { from: "2026-07-26", to: "2026-08-25" };
    // Import tomorrow's period first. A run for August must not consume it.
    await addPackage("2026-08-26", "FICTIONAL-NEXT-PERIOD");
    const prepared = await repository.prepare(c1, period);
    expect(prepared.snapshot.scannedDocuments).toBe(1); expect(prepared.snapshot.candidates).toHaveLength(1);
    await expect(repository.prepare(c1, period)).rejects.toThrow("in_progress");
    await expect(repository.run(c2, prepared.runId)).rejects.toThrow("not_found");
    const run = await repository.claim(c1, prepared.runId, "fictional-worker-1");
    await expect(repository.claim(c1, prepared.runId, "fictional-worker-2")).rejects.toThrow("in_progress");
    const request = (ordinal: number) => ({ ordinal, requestSha256: "d".repeat(64), estimatedInputTokens: 1000, maximumOutputTokens: 8192 });
    const screening = repository.journal(run, "screening", null, managedDigest(managedScreeningInput(run.snapshot)), aiBudget);
    const poisoned = structuredClone(run), original = poisoned.snapshot.candidates[0].source!;
    poisoned.snapshot.candidates[0].source = { ...original, claims: original.claims.map((c,i) => i ? c : { ...c, text: c.text + "INVALID" }) };
    await expect(repository.journal(poisoned, "screening", null, managedDigest(managedScreeningInput(run.snapshot)), aiBudget).reserve(request(1))).rejects.toThrow();
    await expect(repository.journal({ ...run, settingId: other.settingId }, "screening", null, managedDigest(managedScreeningInput(run.snapshot)), aiBudget).reserve(request(1))).rejects.toThrow();
    expect((await repository.run(c1, run.runId)).consumedNormal).toBe(0);
    await screening.reserve(request(1)); await screening.reconcile({ ordinal: 1, inputTokens: 200, outputTokens: 40 });
    run.plan = await repository.saveScreening(run, [run.snapshot.candidates[0].candidateId]);
    // Reconciled usage does not refund the run's original monetary reservations.
    const firstChunk = run.plan.chunks[0], smallBudget = { ...aiBudget, maximumYen: 50 };
    const expensive = repository.journal(run, "detail", 0, managedDigest(firstChunk), smallBudget);
    smallBudget.maximumYen = 30_000; // Caller mutation cannot enlarge the captured permit.
    await expect(expensive.reserve(request(2))).rejects.toThrow("limit");
    expect((await repository.run(c1, run.runId)).consumedNormal).toBe(1);
    expect((await environment.sql("select count(*)::int as n from managed_watch_dispatches where run_id=$1", [run.runId]))[0].n).toBe(1);
    expect(() => repository.journal(run, "detail", 0, managedDigest(firstChunk), undefined as unknown as typeof aiBudget)).toThrow();
    await expect(repository.journal(run, "detail", 0, "e".repeat(64), aiBudget).reserve(request(2))).rejects.toThrow();
    for (const [index, chunk] of run.plan.chunks.entries()) {
      const journal = repository.journal(run, "detail", index, managedDigest(chunk), aiBudget);
      await journal.reserve(request(index + 2)); await journal.reconcile({ ordinal: index + 2, inputTokens: 500, outputTokens: 100 });
      const results = chunk.pairs.map(pair => {
        const b = chunk.base.claims.find(c => c.claimNo === pair.baseClaimNo)!, c = chunk.candidate.claims.find(c => c.claimNo === pair.candidateClaimNo)!;
        return { ...pair, lexicalScore: 0.5, elementScore: 0.5, semanticScore: 0.5, structuralScore: 0.5, riskLabel: "Medium",
          baseEvidence: { claimNo: b.claimNo, start: 0, end: 4, quote: b.text.slice(0,4) },
          candidateEvidence: { claimNo: c.claimNo, start: 0, end: 4, quote: c.text.slice(0,4) }, explanation: "架空入力の要素が一部一致します。人による確認が必要です。" };
      });
      await repository.saveDetail(run, index, { results });
    }
    // A failed finalization cannot leak findings or mark source versions processed.
    await environment.sql(`REVOKE INSERT ON managed_watch_findings FROM ${watcher}`);
    await expect(repository.finalize(run)).rejects.toThrow();
    expect((await repository.run(c1, run.runId)).status).toBe("running");
    expect((await environment.sql("select count(*)::int as n from managed_watch_findings"))[0].n).toBe(0);
    await environment.sql(`GRANT INSERT ON managed_watch_findings TO ${watcher}`);
    const restarted = new ManagedWatchRepository(drizzle(environment.watchClient, { schema }));
    expect((await restarted.finalize(await restarted.run(c1, run.runId))).compared).toBe(1);
    const zero = await repository.prepare(c1, period); expect(zero.snapshot.candidates).toHaveLength(0);
    const zeroRunning = await repository.claim(c1, zero.runId, "fictional-zero");
    expect((await repository.finalize(zeroRunning)).normalCalls).toBe(0);
    const next = await repository.prepare(c1, { from: "2026-08-26", to: "2026-09-25" });
    expect(next.snapshot.candidates).toHaveLength(1); expect(next.snapshot.candidates[0].publicationDate).toBe("2026-08-26");
    const nextRunning = await repository.claim(c1, next.runId, "fictional-next"); await repository.fail(nextRunning, false);
    await addPackage("2026-08-13", "FICTIONAL-LATE", true);
    const late = await repository.prepare(c1, period); expect(late.snapshot.candidates).toHaveLength(1);
    expect(late.snapshot.candidates[0].publicationDate).toBe("2026-08-13");
    const lateRunning = await repository.claim(c1, late.runId, "fictional-late");
    await repository.journal(lateRunning, "screening", null, managedDigest(managedScreeningInput(lateRunning.snapshot)), aiBudget).reserve(request(1));
    expect(await repository.hasUnknownDispatch(lateRunning)).toBe(true);
    await repository.fail(lateRunning, true);
    await expect(repository.prepare(c1, period)).rejects.toThrow("in_progress");
    expect((await repository.run(c1, late.runId)).consumedNormal).toBe(1);
    const finding = (await environment.sql("select finding_id from managed_watch_findings where setting_id=$1", [setting.settingId]))[0];
    await expect(repository.reviewFinding(c2, finding.finding_id, true,0)).rejects.toThrow("not_found");
    await repository.reviewFinding(c1, finding.finding_id, true,0);
    await expect(repository.reviewFinding(c1,finding.finding_id,false,0)).rejects.toThrow("conflict");
    expect(await repository.findingReview(c1,finding.finding_id)).toMatchObject({reviewStatus:"reviewed",reviewVersion:1});
  }, 30_000);
});
