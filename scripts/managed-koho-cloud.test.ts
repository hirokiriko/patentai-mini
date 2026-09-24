import { expect, it, vi } from "vitest";
import { managedCloudImportFixture } from "./managed-koho-cloud.test-support";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import { parseCloudManifest, cloudManifestName, cloudReceiptPrefix, sha256 } from "../src/lib/koho-import/cloud-config";
import type { saveCloudPlan } from "../src/lib/koho-import/cloud-db";
it("binds exact full numbered claims and official receipt into the dedicated corpus save", async () => {
  const f = await managedCloudImportFixture();
  const save = vi.fn<typeof saveCloudPlan>(async (_config,_manifest,_password,plan,begin,_client,managed) => {
    expect(managed).toEqual(f.managed);begin();return {outcome:"inserted",savedDocumentCount:plan.documentCount,databaseGrowthBytes:50,capacityConfirmed:true};
  });
  const result = await runCloudImport(f.config,f.blob,{password:"FICTIONAL_SENTINEL",save,budget:f.budget});
  expect(result.status).toBe("complete");expect(save).toHaveBeenCalledTimes(1);
  expect((await runCloudImport(f.config,f.blob,{password:"FICTIONAL_SENTINEL",save,budget:f.budget})).status).toBe("reconciliation_required");
  expect(save).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toMatch(/FICTIONAL|claimsJson|corrections|sourceSha/);
});
it("blocks altered full-source provenance and over-cap release reservations before any DB save", async () => {
  const f = await managedCloudImportFixture(), save = vi.fn<typeof saveCloudPlan>();
  f.manifest.packages[0].managedSourcesSha256="0".repeat(64);await f.publish();
  const {budget}=f.bindBudget();
  const result=await runCloudImport(f.config,f.blob,{password:"FICTIONAL",save,budget});
  expect(result.status).toBe("reconciliation_required");expect(result.startedAcknowledged).toBe(true);expect(save).not.toHaveBeenCalled();
  const g = await managedCloudImportFixture();g.manifest.releaseReservation.compressedBytes=96*1024**3+1;await g.publish();
  expect(()=>parseCloudManifest(Buffer.from(JSON.stringify(g.manifest)),g.config)).toThrow();
  const h = await managedCloudImportFixture();h.manifest.packages[0].byteLength=8*1024**3+1;await h.publish();
  expect(()=>parseCloudManifest(Buffer.from(JSON.stringify(h.manifest)),h.config)).toThrow();
});
it("accepts only the approved managed compressed capacities and retains the old pilot ceiling", async () => {
  const f = await managedCloudImportFixture();
  f.manifest.packages[0].byteLength = 8 * 1024**3;
  f.manifest.maxTotalBytes = 8 * 1024**3;
  f.manifest.releaseReservation.compressedBytes = 96 * 1024**3;
  await f.publish();
  expect(parseCloudManifest(Buffer.from(JSON.stringify(f.manifest)), f.config).packages[0].byteLength).toBe(8 * 1024**3);
  const legacy = { ...f.manifest, approval: "REGULAR_PRODUCTION_PILOT_V1", maxTotalBytes: 4 * 1024**3,
    packages: f.manifest.packages.map(p => { const copy: Record<string, unknown> = { ...p };
      copy.byteLength = 2 * 1024**3 + 1;
      delete copy.managedSourcesSha256; delete copy.managedReceiptSha256; return copy; }) };
  const oldManifest: Record<string, unknown> = { ...legacy }; delete oldManifest.releaseReservation;
  const { sha256 } = await import("../src/lib/koho-import/cloud-config");
  const bytes = Buffer.from(JSON.stringify(oldManifest));
  expect(() => parseCloudManifest(bytes, { ...f.config, approval: "REGULAR_PRODUCTION_PILOT_V1",
    manifest: { ...f.config.manifest, sha256: sha256(bytes), byteLength: bytes.length } })).toThrow();
});
it("requires the shared budget before any managed worker marker, download or DB save",async()=>{
  const f=await managedCloudImportFixture(),save=vi.fn<typeof saveCloudPlan>(),download=vi.spyOn(f.blob,"download");
  const result=await runCloudImport(f.config,f.blob,{password:"FICTIONAL",save});
  expect(result.startedAcknowledged).toBe(false);expect(download).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
  expect(f.blob.objects.has(cloudReceiptPrefix(f.config)+"started.json")).toBe(false);
});
it("preserves full claims and the dedicated import scope in post-GO Standard mode",async()=>{
  const f=await managedCloudImportFixture(),{releaseReservation,...body}=f.manifest;void releaseReservation;
  const manifest={...body,approval:"STANDARD_MANAGED_WATCH_STANDARD_V1" as const,round:41};
  const bytes=Buffer.from(JSON.stringify(manifest)),name=cloudManifestName(f.config),etag=await f.blob.replace(name,bytes,f.config.manifest.etag);
  const config={...f.config,approval:manifest.approval,manifest:{byteLength:bytes.length,sha256:sha256(bytes),etag},
    serviceBudget:{...f.config.serviceBudget!,profileDigest:"d".repeat(64)}};
  const verify=vi.fn(async()=>({expiresAt:manifest.expiresAt,remainingMs:60*60_000}));
  const save=vi.fn<typeof saveCloudPlan>(async(_c,_m,_p,plan,begin,_factory,managed)=>{expect(managed).toEqual(f.managed);begin();return{outcome:"inserted",savedDocumentCount:plan.documentCount,databaseGrowthBytes:50,capacityConfirmed:true};});
  expect((await runCloudImport(config,f.blob,{password:"FICTIONAL",save,budget:{verify}})).status).toBe("complete");
  expect(verify).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledOnce();
});
