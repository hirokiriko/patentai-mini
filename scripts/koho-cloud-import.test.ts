import { expect, it, vi } from "vitest";
import { cloudFixture } from "./koho-cloud-import-fixtures";
import { parseCloudConfiguration, parseCloudManifest, cloudReceiptPrefix } from "../src/lib/koho-import/cloud-config";
import { cloudManagedIdentity } from "../src/lib/koho-import/cloud-blob";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import { readUpdateReceipt } from "../src/lib/koho-import/update-check-receipts";
import type { saveCloudPlan } from "../src/lib/koho-import/cloud-db";

const saving = () => vi.fn<typeof saveCloudPlan>(async (_c, _m, _p, plan, begin) => { begin(); return {
  outcome: "inserted", savedDocumentCount: plan.documentCount, databaseGrowthBytes: 10, capacityConfirmed: true }; });
it("runs real parser/plan, private receipt v1 and fixed aggregate through the Blob boundary", async () => {
  const f = await cloudFixture(), save = saving();
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL-SECRET", save });
  expect(result).toMatchObject({ status: "complete", receiptAcknowledgement: "confirmed", cleanup: "complete", exitCode: 0 });
  expect(result.results[0]).toMatchObject({ outcome: "inserted", savedDocumentCount: 1 }); expect(save).toHaveBeenCalledOnce();
  const receipt = readUpdateReceipt(f.blob.objects.get(cloudReceiptPrefix(f.config) + "receipt.jsonl")!.bytes);
  expect(receipt).toMatchObject({ invalid: false, structuralComplete: true, endAcknowledgement: "unconfirmed" });
  const stdout = JSON.stringify(result);
  for (const secret of ["FICTIONAL", f.config.expectedTarget.host, f.config.operationId, f.config.manifest.sha256, f.manifest.packages[0].sha256, "publication", "claims"]) expect(stdout.includes(secret)).toBe(false);
});
it.each(["target", "code", "environment", "expiry", "hash", "package_limit", "total_limit", "unknown_key", "duplicate"])("rejects %s before saving", async kind => {
  const f = await cloudFixture(), save = saving();
  if (kind === "target") f.manifest.target = { ...f.manifest.target, database: "other" };
  if (kind === "code") f.manifest.codeSha = "c".repeat(40);
  if (kind === "environment") f.manifest.environmentResourceId += "other";
  if (kind === "expiry") f.manifest.expiresAt = new Date(Date.now() - 1000).toISOString();
  if (kind === "package_limit") f.manifest.packages[0].byteLength = 2 * 1024 ** 3 + 1;
  if (kind === "total_limit") f.manifest.maxTotalBytes = 4 * 1024 ** 3 + 1;
  if (kind === "duplicate") f.manifest.packages.push(f.manifest.packages[0]);
  if (kind === "unknown_key") Object.assign(f.manifest, { sourceUrl: "https://fictional.invalid/input.zip" });
  await f.publish(); if (kind === "hash") f.config.manifest.sha256 = "d".repeat(64);
  expect((await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save })).exitCode).toBe(2);
  expect(save).not.toHaveBeenCalled(); expect([...f.blob.objects.keys()].filter(k => k.includes("started.json"))).toHaveLength(0);
});
it.each(["etag", "source_hash", "plan", "count", "date", "review", "issue"])("rejects %s change after acceptance but before DB", async kind => {
  const f = await cloudFixture(), save = saving(), p = f.manifest.packages[0];
  if (kind === "etag") p.etag = '"different"';
  if (kind === "source_hash") { const object = f.blob.objects.get(`inputs/${p.sha256}.zip`)!; object.bytes[0] ^= 1; }
  if (kind === "plan") p.planSha256 = "0".repeat(64);
  if (kind === "count") p.documentCount++;
  if (kind === "date") p.publicationDate = "2099-03-12";
  if (kind === "review") p.expectedReviewRequired = !p.expectedReviewRequired;
  if (kind === "issue") p.issueNumber = "FICTIONAL-WRONG-ISSUE";
  await f.publish(); const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(result.results[0].outcome).toBe("failed_before_save"); expect(save).not.toHaveBeenCalled();
});
it("rejects public container and arbitrary runtime URL/command/credential values", async () => {
  const f = await cloudFixture(), save = saving(); f.blob.private = false;
  expect((await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save })).exitCode).toBe(2); expect(save).not.toHaveBeenCalled();
  expect(() => parseCloudConfiguration({ ...f.config, command: "anything" })).toThrow();
  expect(() => parseCloudConfiguration({ ...f.config, storageAccount: "https://other.invalid" })).toThrow();
  expect(() => cloudManagedIdentity(f.config, { IDENTITY_ENDPOINT: "https://other.invalid/msi/token", IDENTITY_HEADER: "FICTIONAL" })).toThrow();
  expect(() => cloudManagedIdentity(f.config, { IDENTITY_ENDPOINT: "http://127.0.0.1:1/msi/token?resource=other", IDENTITY_HEADER: "FICTIONAL" })).toThrow();
});
it("exclusively claims an operation before DB, rejecting concurrent and finished replay", async () => {
  const f = await cloudFixture(), save = saving();
  const results = await Promise.all([runCloudImport(f.config, f.blob, { password: "FICTIONAL", save }), runCloudImport(f.config, f.blob, { password: "FICTIONAL", save })]);
  expect(results.map(x => x.exitCode).sort()).toEqual([0, 2]); expect(save).toHaveBeenCalledOnce();
  expect((await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save })).exitCode).toBe(2); expect(save).toHaveBeenCalledOnce();
});
it("does not replay a persisted start marker after its response is lost", async () => {
  const f = await cloudFixture(), save = saving(), original = f.blob.create.bind(f.blob);
  f.blob.create = async (name, bytes) => { const etag = await original(name, bytes);
    if (name.endsWith("started.json")) throw Error("FICTIONAL_ACK_LOST"); return etag; };
  const first = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(first.startedAcknowledged).toBe(false); expect(f.blob.objects.has(cloudReceiptPrefix(f.config) + "started.json")).toBe(true);
  f.blob.create = original;
  expect((await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save })).startedAcknowledged).toBe(false);
  expect(save).not.toHaveBeenCalled();
});
it("leaves final ACK unconfirmed when the completion object persisted but response was lost", async () => {
  const f = await cloudFixture(), save = saving(), original = f.blob.create.bind(f.blob);
  f.blob.create = async (name, bytes) => { const etag = await original(name, bytes);
    if (name.endsWith("finished.json")) throw Error("FICTIONAL_ACK_LOST"); return etag; };
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(result.receiptAcknowledgement).toBe("unconfirmed"); expect(result.results[0].outcome).toBe("inserted");
  expect(f.blob.objects.has(cloudReceiptPrefix(f.config) + "finished.json")).toBe(true);
  expect(readUpdateReceipt(f.blob.objects.get(cloudReceiptPrefix(f.config) + "receipt.jsonl")!.bytes).structuralComplete).toBe(true);
});
it("retains an acknowledged insert when subsequent receipt write loses its ACK", async () => {
  const f = await cloudFixture(), save = saving();
  const wrapped: typeof saveCloudPlan = async (...args) => { const saved = await save(...args); f.blob.fail = (name, write) => write && name.endsWith("receipt.jsonl"); return saved; };
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save: wrapped });
  expect(result).toMatchObject({ receiptAcknowledgement: "unconfirmed", exitCode: 2 }); expect(result.results[0].outcome).toBe("inserted");
  expect(readUpdateReceipt(f.blob.objects.get(cloudReceiptPrefix(f.config) + "receipt.jsonl")!.bytes).structuralComplete).toBe(false);
});
it("stops before DB when the durable input verification receipt fails", async () => {
  const f = await cloudFixture(), save = saving(); let writes = 0;
  f.blob.fail = (name, write) => write && name.endsWith("receipt.jsonl") && ++writes === 2;
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(result.receiptAcknowledgement).toBe("unconfirmed"); expect(save).not.toHaveBeenCalled();
});
it("keeps COMMIT transport loss unknown and does not retry", async () => {
  const f = await cloudFixture(), save = vi.fn<typeof saveCloudPlan>(async (_c, _m, _p, _plan, begin) => { begin(); throw Error("FICTIONAL_PRIVATE_ERROR"); });
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(result.results[0].outcome).toBe("save_outcome_unknown"); expect(save).toHaveBeenCalledOnce(); expect(result.receiptAcknowledgement).toBe("confirmed");
});
it("preserves insert on failed postcommit capacity check and does not process next input", async () => {
  const f = await cloudFixture(), second = await cloudFixture({ blob: f.blob, issue: "FICTIONAL-SECOND", publicationDate: "2099-03-12" });
  f.manifest.packages.push(second.manifest.packages[0]); await f.publish();
  const save = vi.fn<typeof saveCloudPlan>(async (_c, _m, _p, plan, begin) => { begin(); return { outcome: "inserted", savedDocumentCount: plan.documentCount, databaseGrowthBytes: 999, capacityConfirmed: false }; });
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(result.results.map(r => r.outcome)).toEqual(["inserted", "not_processed"]); expect(result.exitCode).toBe(2); expect(save).toHaveBeenCalledOnce();
});
it("passes only remaining manifest capacity reserve to the next package", async () => {
  const f = await cloudFixture(), second = await cloudFixture({ blob: f.blob, issue: "FICTIONAL-SECOND", publicationDate: "2099-03-12" });
  f.manifest.packages.push(second.manifest.packages[0]); f.manifest.reservedGrowthBytes = 100; await f.publish();
  const save = vi.fn<typeof saveCloudPlan>(async (_c, m, _p, plan, begin) => { begin(); return {
    outcome: "inserted", savedDocumentCount: plan.documentCount, databaseGrowthBytes: 60, capacityConfirmed: m.reservedGrowthBytes >= 60 }; });
  const result = await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save });
  expect(save.mock.calls.map(call => call[1].reservedGrowthBytes)).toEqual([100, 40]);
  expect(result.capacityConfirmed).toBe(false); expect(result.exitCode).toBe(2);
});
it("separates preview and explicit review admission from persistence", async () => {
  const f = await cloudFixture({ review: true }), save = saving();
  expect((await runCloudImport(f.config, f.blob, { password: "FICTIONAL", save })).results[0].outcome).toBe("review_not_saved"); expect(save).not.toHaveBeenCalled();
  const preview = await cloudFixture({ review: true }); preview.config.mode = preview.manifest.mode = "preview"; await preview.publish();
  expect((await runCloudImport(preview.config, preview.blob, { save })).results[0].outcome).toBe("preview_not_saved"); expect(save).not.toHaveBeenCalled();
  const approved = await cloudFixture({ review: true }); approved.manifest.allowReviewRequired = true; await approved.publish();
  expect((await runCloudImport(approved.config, approved.blob, { password: "FICTIONAL", save })).results[0].includesReviewRequired).toBe(true);
});
it("stops an already aborted execution without marker or DB save", async () => {
  const f = await cloudFixture(), save = saving(), controller = new AbortController(); controller.abort();
  expect((await runCloudImport(f.config, f.blob, { signal: controller.signal, password: "FICTIONAL", save })).exitCode).toBe(2); expect(save).not.toHaveBeenCalled();
});
it("rejects expired or overlong manifest approval even with matching hash", async () => {
  const f = await cloudFixture(); f.manifest.expiresAt = new Date(Date.now() + 7 * 60 * 60_000).toISOString(); await f.publish();
  expect(() => parseCloudManifest(Buffer.from(JSON.stringify(f.manifest)), f.config)).toThrow();
});
