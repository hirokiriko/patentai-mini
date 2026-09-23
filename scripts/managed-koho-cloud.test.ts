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
  const g = await managedCloudImportFixture();g.manifest.releaseReservation.compressedBytes=64*1024**3+1;await g.publish();
  expect(()=>parseCloudManifest(Buffer.from(JSON.stringify(g.manifest)),g.config)).toThrow();
  const h = await managedCloudImportFixture();h.manifest.packages[0].byteLength=2*1024**3+1;await h.publish();
  expect(()=>parseCloudManifest(Buffer.from(JSON.stringify(h.manifest)),h.config)).toThrow();
});
