import { describe, expect, it, vi } from "vitest";
import { manualFixture } from "../../../scripts/koho-manual-import-fixtures";
import { DISTRIBUTION_HEADERS } from "../koho-distribution-table";
import { MANAGED_DISTRIBUTION_URL } from "../patent-watch/managed-distribution";
import { sha256 } from "./cloud-config";
import { uploadFixture } from "./upload.test-support";
import { startKohoUpload } from "./upload-arm";
import { runKohoUpload } from "./upload-runtime";
import { kohoUploadPrefix } from "./upload-contract";
import type { saveUploadedCloudPlan } from "./cloud-db";

function distribution(count = 1) {
  const csvText = [DISTRIBUTION_HEADERS.JPA.join(","),
    ["20260812", "148", "01122", "000001", "000001", "", "", String(count).padStart(5, "0"), "00000", "可", ""].join(",")].join("\r\n") + "\r\n";
  return { csvText, sha256: sha256(csvText), sourceUrl: MANAGED_DISTRIBUTION_URL, acquiredAt: new Date().toISOString() };
}
async function prepared() {
  const bytes = manualFixture("JPA", 1, { issue: "2026-148", publicationDate: "2026-08-12" });
  const f = uploadFixture(bytes.length); await f.store.create(f.input); await f.store.chunk(f.input.operationId, 0, bytes);
  await f.store.seal(f.input.operationId); await startKohoUpload(f.store, f.input.operationId, f.arm);
  const save = vi.fn<typeof saveUploadedCloudPlan>(async (...args) => { args[4]();
    return { outcome: "inserted", capacityConfirmed: true, savedDocumentCount: 1, databaseGrowthBytes: 100 }; });
  return { ...f, save, dependencies: { save, distribution: async () => distribution() } };
}
describe("fixed cloud upload worker", () => {
  it.each(["inserted", "reused"] as const)("parses the real fictional ZIP and retains original, source evidence and %s receipt", async outcome => {
    const f = await prepared(); f.save.mockImplementation(async (...args) => { args[4]();
      return { outcome, capacityConfirmed: true, savedDocumentCount: 1, databaseGrowthBytes: 0 }; });
    expect(await runKohoUpload(f.state().intent, f.store, "FICTIONAL_PASSWORD", f.signal, f.dependencies)).toEqual({ status: "complete", exitCode: 0 });
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.state().result).toMatchObject({ disposition: outcome, documentCount: 1 });
    const names = [...f.files.keys()]; expect(names.filter(n => n.endsWith("source.zip"))).toHaveLength(1);
    expect(names.some(n => n.endsWith("verified-archive.json"))).toBe(true); expect(names.some(n => n.endsWith("finished.json"))).toBe(true);
    await expect(runKohoUpload(f.state().intent, f.store, "FICTIONAL_PASSWORD", f.signal, f.dependencies)).rejects.toThrow();
    expect(f.save).toHaveBeenCalledTimes(1);
  });
  it("does not import when official publication identity/counts disagree", async () => {
    const f = await prepared();
    await runKohoUpload(f.state().intent, f.store, "FICTIONAL_PASSWORD", f.signal, { ...f.dependencies, distribution: async () => distribution(2) });
    expect(f.save).not.toHaveBeenCalled(); expect(f.state().status).toBe("failed"); expect(f.state().result).toBeNull();
  });
  it("recovers successful DB receipt read-only after final state persistence fails", async () => {
    const f = await prepared();
    f.setBeforeWrite((_kind, name, b) => { if (name.endsWith("state.json") && JSON.parse(b.toString()).status === "complete") throw Error("FICTIONAL_WRITE_FAILED"); });
    await runKohoUpload(f.state().intent, f.store, "FICTIONAL_PASSWORD", f.signal, f.dependencies);
    expect(f.state().status).toBe("outcome_unknown");
    const writes = f.calls.filter(c => c.startsWith("PUT:")).length;
    expect((await f.store.reconciled(f.input.operationId)).status).toBe("complete");
    expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(writes); expect(f.save).toHaveBeenCalledTimes(1);
    const receipt = f.files.get(kohoUploadPrefix(f.input.operationId) + "finished.json")!;
    const v = JSON.parse(receipt.bytes.toString()); v.intentDigest = "0".repeat(64); receipt.bytes = Buffer.from(JSON.stringify(v));
    await expect(f.store.reconciled(f.input.operationId)).rejects.toThrow();
  });
  it("continues after processing-state ACK loss without a second worker or DB call", async () => {
    const f = await prepared(); let lost = false;
    f.setAfterWrite((_kind, name, b) => { if (!lost && name.endsWith("state.json") && JSON.parse(b.toString()).status === "processing") { lost = true; throw Error("FICTIONAL_ACK_LOST"); } });
    expect((await runKohoUpload(f.state().intent, f.store, "FICTIONAL_PASSWORD", f.signal, f.dependencies)).status).toBe("complete");
    expect(lost).toBe(true); expect(f.save).toHaveBeenCalledTimes(1);
  });
});
