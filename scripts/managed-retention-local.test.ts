import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedPg16 } from "./watch-report-local.test-support";
import * as schema from "../src/db/schema";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { ManagedRetentionRepository } from "../src/repositories/managed-retention";
import { ManagedBackupRepository, parseManagedCaseBackup } from "../src/repositories/managed-backup";
import { ManagedArchiveStorage, archiveSha, type ArchiveBlob } from "../src/lib/patent-watch/managed-archive-storage";
import { restoreManagedBackup, verifyManagedBackupRestore } from "./managed-watch-restore";
import { artifactAdmissionFixture } from "../src/lib/patent-watch/managed-artifact.test-support";
import { MANAGED_CASE_TABLES, withManagedOriginalUpload, type ManagedDatabase } from "../src/repositories/managed-case-graph";
import { addFictionalManagedOriginal } from "./managed-base.test-support";
import { managedArtifactName } from "../src/lib/patent-watch/managed-storage";
import { managedDeliveryFixture } from "../src/lib/patent-watch/managed-delivery.test-support";

function memoryStorage() {
  const blobs = new Map<string,Buffer>(); let deleteFailure = false;
  const implementation = {
    location:"https://fictional.blob.core.windows.net/private",
    withDeadline(deadline:AbortSignal){deadline.throwIfAborted();return this;},
    async list(caseId:number) { return [...blobs.keys()].filter(k=>k.startsWith(`cases/${caseId}/`)).sort(); },
    async read(_caseId:number,name:string) { const data=blobs.get(name);return data?{metadata:{name,bytes:data.length,sha256:archiveSha(data),etag:archiveSha(data)},data:Buffer.from(data)}:null; },
    async writeBackup(caseId:number,id:string,bytes:Buffer) { const name=`cases/${caseId}/managed-backups/${id}.json`;if(blobs.has(name))throw Error("conflict");blobs.set(name,Buffer.from(bytes)); },
    async remove(_caseId:number,entry:ArchiveBlob) { if(deleteFailure)throw Error("fictional_storage_failure");blobs.delete(entry.name); },
  };
  return {storage:implementation as unknown as ManagedArchiveStorage,blobs,fail:(value:boolean)=>{deleteFailure=value;}};
}
describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST!=="1")("managed retention and isolated PG16 restore",()=>{
  let environment:Awaited<ReturnType<typeof isolatedPg16>>,database:ManagedDatabase;
  beforeAll(async()=>{environment=await isolatedPg16(129);database=drizzle(environment.admin,{schema});},120_000);
  afterAll(async()=>{await environment?.cleanup();},60_000);
  async function fixture(storage:ReturnType<typeof memoryStorage>) {
    const caseId=(await environment.sql("insert into cases(title) values('FICTIONAL RETENTION') returning case_id"))[0].case_id as number;
    const original=await addFictionalManagedOriginal(caseId,environment.sql,storage.blobs);
    await new ManagedWatchRepository(database,async(_caseId,_category,name)=>({bytes:storage.blobs.get(name)!,contentType:"application/xml"})).saveSetting({caseId,contractSignedOn:"2026-01-01",monitoringStartsOn:"2026-01-01",contractEndsOn:"2026-02-01",enabled:false,
      base:original.base,source:original.source,selectedClaimNos:[1]});
    const name=`cases/${caseId}/drafts/main/1700000000000-${randomUUID()}-fictional.txt`;
    const data=Buffer.from("完全架空の復元検証用原本。");storage.blobs.set(name,data);
    await environment.sql("insert into draft_patents(case_id,kind,source_file_path,parsed_text) values($1,'main',$2,$3)",[caseId,name,data.toString()]);
    return {caseId,name};
  }
  it("requires end+91 JST, immutable preview, explicit digest, and preserves other case and audit rows",async()=>{
    const s=memoryStorage(),f=await fixture(s),other=await fixture(s),repository=new ManagedRetentionRepository(database,s.storage);
    await expect(repository.preview(f.caseId,Date.parse("2026-05-02T14:59:59Z"))).rejects.toThrow("expired");
    const preview=await repository.preview(f.caseId,Date.parse("2026-05-02T15:00:00Z"));
    expect(preview.eligibleOn).toBe("2026-05-03");expect(s.blobs.has(f.name)).toBe(true);
    await expect(repository.execute(f.caseId,preview.deletionId,"0".repeat(64))).rejects.toThrow("incomplete");
    await environment.sql("update cases set title='FICTIONAL CHANGED' where case_id=$1",[f.caseId]);
    await expect(repository.execute(f.caseId,preview.deletionId,preview.manifestDigest)).rejects.toThrow("incomplete");
    const next=await repository.preview(f.caseId);s.fail(true);
    await expect(repository.execute(f.caseId,next.deletionId,next.manifestDigest)).rejects.toThrow("outcome_unknown");
    expect((await environment.sql("select case_id from cases where case_id=$1",[f.caseId])).length).toBe(0);
    expect((await repository.get(f.caseId,next.deletionId)).row.status).toBe("reconciliation_required");
    s.fail(false);expect((await repository.reconcile(f.caseId,next.deletionId,next.manifestDigest)).status).toBe("complete");
    expect((await repository.reconcile(f.caseId,next.deletionId,next.manifestDigest)).status).toBe("complete");
    expect(s.blobs.has(other.name)).toBe(true);expect((await environment.sql("select case_id from cases where case_id=$1",[other.caseId])).length).toBe(1);
    expect((await repository.get(f.caseId,preview.deletionId)).row.status).toBe("preview");
    const removeOther=await repository.preview(other.caseId);await repository.execute(other.caseId,removeOther.deletionId,removeOther.manifestDigest);
    await expect(withManagedOriginalUpload(database,f.caseId,async()=>{throw Error("must_not_upload");})).rejects.toThrow("not_found");
  },30_000);
  it("reserves an immutable backup, reads it back, verifies corruption rejection, and restores into a fresh PG16",async()=>{
    const s=memoryStorage(),f=await fixture(s),budget=artifactAdmissionFixture(),backups=new ManagedBackupRepository(database,s.storage,budget.admit),backupId=randomUUID();
    const created=await backups.create(f.caseId,backupId);expect(created.status).toBe("stored");
    await expect(backups.create(f.caseId,backupId)).rejects.toThrow("conflict");
    const saved=await backups.read(f.caseId,backupId);
    // A current admission outage must not prevent historical verification.
    const historical=new ManagedBackupRepository(database,s.storage,async()=>{throw Error("current_budget_unavailable");});
    expect((await historical.read(f.caseId,backupId)).row.sha256).toBe(saved.row.sha256);
    expect((await historical.reconcile(f.caseId,backupId)).status).toBe("stored");
    const corrupt=Buffer.from(saved.bytes);corrupt[corrupt.length-3]^=1;
    expect(()=>parseManagedCaseBackup(corrupt,saved.row.sha256,f.caseId,backupId)).toThrow("incomplete");
    const recoveryOperationId=randomUUID();
    expect(await restoreManagedBackup(backups,f.caseId,backupId,recoveryOperationId,AbortSignal.timeout(90_000),budget.admit)).toMatchObject({verified:true,caseId:f.caseId,artifacts:2,productionWrite:false});
    expect(budget.records.get(recoveryOperationId)).toMatchObject({kind:"recovery",sha256:saved.row.sha256,bytes:saved.row.bytes});
    await expect(restoreManagedBackup(backups,f.caseId,backupId,recoveryOperationId,AbortSignal.timeout(90_000),budget.admit)).rejects.toThrow("conflict");
    const retention=new ManagedRetentionRepository(database,s.storage),preview=await retention.preview(f.caseId);
    expect(preview.blobs).toBe(3);await retention.execute(f.caseId,preview.deletionId,preview.manifestDigest);
    expect(s.blobs.size).toBe(0);expect((await environment.sql("select backup_id from managed_watch_backups where case_id=$1",[f.caseId])).length).toBe(0);
  },120_000);
  it("backs up existing query and comparison rows without granting their UPDATE privilege",async()=>{
    const s=memoryStorage(),f=await fixture(s),role=String((await environment.watchClient.query("select current_user as role")).rows[0].role);
    expect(role).toMatch(/^watch_test_[a-f0-9]{16}$/);
    for(const [table] of MANAGED_CASE_TABLES){
      const privileges=table==="search_query_sets"||table==="comparison_results"?"SELECT":"SELECT, UPDATE";
      await environment.sql(`GRANT ${privileges} ON public.${table} TO ${role}`);
    }
    await environment.sql(`GRANT SELECT, INSERT, UPDATE ON public.managed_watch_backups TO ${role}`);
    await environment.sql(`GRANT SELECT ON public.koho_import_runs, public.koho_import_documents, public.managed_distribution_snapshots TO ${role}`);
    for(const table of ["search_query_sets","comparison_results"]){
      expect((await environment.watchClient.query("select has_table_privilege(current_user,$1,'SELECT') as readable,has_any_column_privilege(current_user,$1,'UPDATE') as mutable",[`public.${table}`])).rows[0]).toEqual({readable:true,mutable:false});
    }
    await environment.sql("insert into search_query_sets(case_id,broad_query) values($1,'FICTIONAL BACKUP QUERY')",[f.caseId]);
    const prior=(await environment.sql("select doc_id from prior_art_documents where case_id=$1",[f.caseId]))[0].doc_id;
    await environment.sql("insert into comparison_results(case_id,prior_doc_id,risk_label) values($1,$2,'Low')",[f.caseId,prior]);
    const beforeQuery=await environment.sql("select to_jsonb(t) as row from search_query_sets t where case_id=$1",[f.caseId]);
    const beforeComparison=await environment.sql("select to_jsonb(t) as row from comparison_results t where case_id=$1",[f.caseId]);
    const backups=new ManagedBackupRepository(drizzle(environment.watchClient,{schema}),s.storage,artifactAdmissionFixture().admit),backupId=randomUUID();
    const read=s.storage.read.bind(s.storage);
    let release!:()=>void,reading!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{reading=resolve;});
    s.storage.read=async(caseId,name)=>{reading();await held;return read(caseId,name);};
    const creating=backups.create(f.caseId,backupId);
    try {
      await Promise.race([reached,creating.then(()=>{throw Error("backup_did_not_read_original");})]);
      await environment.admin.query("set lock_timeout='250ms'");
      // The parent case stays locked even though these two child tables are read-only.
      await expect(environment.admin.query("insert into search_query_sets(case_id,broad_query) values($1,'FICTIONAL CONCURRENT QUERY')",[f.caseId])).rejects.toMatchObject({code:"55P03"});
      await expect(environment.admin.query("insert into comparison_results(case_id,prior_doc_id,risk_label) values($1,$2,'Low')",[f.caseId,prior])).rejects.toMatchObject({code:"55P03"});
    } finally {
      release();await environment.admin.query("set lock_timeout=0");
      await creating;
    }
    expect((await creating).status).toBe("stored");
    const saved=await backups.read(f.caseId,backupId);
    expect(saved.archive.graph.search_query_sets).toEqual(beforeQuery.map(r=>r.row));
    expect(saved.archive.graph.comparison_results).toEqual(beforeComparison.map(r=>r.row));
    expect(await environment.sql("select to_jsonb(t) as row from search_query_sets t where case_id=$1",[f.caseId])).toEqual(beforeQuery);
    expect(await environment.sql("select to_jsonb(t) as row from comparison_results t where case_id=$1",[f.caseId])).toEqual(beforeComparison);
    expect(await verifyManagedBackupRestore(saved.bytes,saved.row.sha256,f.caseId,backupId)).toMatchObject({verified:true,caseId:f.caseId,artifacts:2});
    expect((await environment.admin.query("insert into search_query_sets(case_id,broad_query) values($1,'FICTIONAL AFTER BACKUP')",[f.caseId])).rowCount).toBe(1);
    expect((await environment.admin.query("insert into comparison_results(case_id,prior_doc_id,risk_label) values($1,$2,'Low')",[f.caseId,prior])).rowCount).toBe(1);
  },120_000);
  it("retains abandoned deliveries, records only permitted missing artifacts, and verifies the bound original",async()=>{
    const s=memoryStorage(),f=await fixture(s),backups=new ManagedBackupRepository(database,s.storage,artifactAdmissionFixture().admit);
    const setting=(await environment.sql("select setting_id,base_digest from managed_watch_settings where case_id=$1",[f.caseId]))[0];
    const distribution=archiveSha(Buffer.from("fictional-distribution"));
    await database.insert(schema.managedDistributionSnapshots).values({sha256:distribution,sourceUrl:"https://fictional.invalid/JPA.csv",csvText:"fictional",acquiredAt:new Date().toISOString()});
    const deliveryId=randomUUID(),report={...managedDeliveryFixture(),caseId:f.caseId,deliveryId};
    const data={snapshot:Buffer.from(JSON.stringify(report)),pdf:Buffer.from("fictional-pdf"),csv:Buffer.from("fictional-csv")};
    const manifest={schema:1,caseId:f.caseId,deliveryId,artifacts:(["snapshot","pdf","csv"] as const).map(kind=>({kind,bytes:data[kind].length,sha256:archiveSha(data[kind])}))};
    const row={deliveryId,caseId:f.caseId,settingId:Number(setting.setting_id),periodFrom:report.period.from,periodTo:report.period.to,version:1,
      reason:"initial",status:"abandoned",baseDigest:String(setting.base_digest),distributionSha256:distribution,snapshotJson:JSON.stringify(report),snapshotDigest:archiveSha(data.snapshot),blobManifestJson:JSON.stringify(manifest)};
    await database.insert(schema.managedWatchDeliveries).values(row);
    const secondId=randomUUID(),secondSnapshot=JSON.stringify({...report,deliveryId:secondId,version:2,previousDeliveryId:deliveryId});
    await database.insert(schema.managedWatchDeliveries).values({...row,deliveryId:secondId,version:2,previousDeliveryId:deliveryId,blobManifestJson:null,snapshotJson:secondSnapshot,snapshotDigest:archiveSha(Buffer.from(secondSnapshot))});
    s.blobs.set(managedArtifactName(f.caseId,deliveryId,"snapshot"),data.snapshot);
    const backupId=randomUUID();await backups.create(f.caseId,backupId);const saved=await backups.read(f.caseId,backupId);
    expect(saved.archive.missingArtifacts).toHaveLength(2);expect(saved.archive.graph.managed_watch_deliveries).toHaveLength(2);
    expect(await verifyManagedBackupRestore(saved.bytes,saved.row.sha256,f.caseId,backupId)).toMatchObject({verified:true,artifacts:3,missingArtifacts:2});
    const changed=structuredClone(saved.archive);changed.graph.managed_watch_deliveries[0].status="stored";
    const changedBytes=Buffer.from(JSON.stringify(changed));expect(()=>parseManagedCaseBackup(changedBytes,archiveSha(changedBytes),f.caseId,backupId)).toThrow();
    const original=structuredClone(saved.archive),source=JSON.parse(String(original.graph.managed_watch_settings[0].source_json));source.sha256="0".repeat(64);
    original.graph.managed_watch_settings[0].source_json=JSON.stringify(source);const originalBytes=Buffer.from(JSON.stringify(original));
    expect(()=>parseManagedCaseBackup(originalBytes,archiveSha(originalBytes),f.caseId,backupId)).toThrow("invalid_base_source");
    s.blobs.set(managedArtifactName(f.caseId,deliveryId,"pdf"),Buffer.from("wrong-content"));
    await expect(backups.create(f.caseId,randomUUID())).rejects.toThrow("incomplete");
  },120_000);
});
