import { expect, it, vi } from "vitest";
import { managedCloudImportFixture } from "./managed-koho-cloud.test-support";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import { parseCloudManifest } from "../src/lib/koho-import/cloud-config";
import type { saveCloudPlan } from "../src/lib/koho-import/cloud-db";
it("binds exact full numbered claims and official receipt into the dedicated corpus save", async () => {
  const f = await managedCloudImportFixture();
  const save = vi.fn<typeof saveCloudPlan>(async (_config,_manifest,_password,plan,begin,_client,managed) => {
    expect(managed).toEqual(f.managed);begin();return {outcome:"inserted",savedDocumentCount:plan.documentCount,databaseGrowthBytes:50,capacityConfirmed:true};
  });
  const result = await runCloudImport(f.config,f.blob,{password:"FICTIONAL_SENTINEL",save});
  expect(result.status).toBe("complete");expect(save).toHaveBeenCalledTimes(1);
  expect((await runCloudImport(f.config,f.blob,{password:"FICTIONAL_SENTINEL",save})).status).toBe("reconciliation_required");
  expect(save).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toMatch(/FICTIONAL|claimsJson|corrections|sourceSha/);
});
it("blocks altered full-source provenance and over-cap release reservations before any DB save", async () => {
  const f = await managedCloudImportFixture(), save = vi.fn<typeof saveCloudPlan>();
  f.manifest.packages[0].managedSourcesSha256="0".repeat(64);await f.publish();
  expect((await runCloudImport(f.config,f.blob,{password:"FICTIONAL",save})).status).toBe("reconciliation_required");expect(save).not.toHaveBeenCalled();
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
