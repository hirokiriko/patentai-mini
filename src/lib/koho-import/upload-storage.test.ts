import { describe, expect, it } from "vitest";
import { uploadFixture } from "./upload.test-support";
import { kohoUploadBlockId, publicKohoUpload } from "./upload-contract";
import { startKohoUpload } from "./upload-arm";

const bytes = Buffer.from("fictional");
async function uploaded() {
  const f = uploadFixture(bytes.length); await f.store.create(f.input);
  await f.store.chunk(f.input.operationId, 0, bytes); await f.store.seal(f.input.operationId); return f;
}
describe("OWNER upload real-SDK storage and start", () => {
  it("uses fixed 36-byte block identities accepted by Azure", () => {
    expect(Buffer.from(kohoUploadBlockId(2047, "a".repeat(64)), "base64")).toHaveLength(36);
    expect(kohoUploadBlockId(0, "a".repeat(64))).not.toBe(kohoUploadBlockId(1, "a".repeat(64)));
  });
  it("seals one immutable source and does not restage an acknowledged identical chunk", async () => {
    const f = await uploaded(); await f.store.chunk(f.input.operationId, 0, bytes); await f.store.seal(f.input.operationId);
    expect(f.calls.filter(c => c.startsWith("PUT:stage:"))).toHaveLength(1);
    expect(f.calls.filter(c => c.startsWith("PUT:commit:"))).toHaveLength(1);
    expect(f.state().status).toBe("uploaded");
    expect(JSON.stringify(publicKohoUpload(f.state()))).not.toMatch(/sha256|blob.core|databaseSecretRef|targetBindingHash/);
    await expect(f.store.chunk(f.input.operationId, 0, Buffer.from("different"))).rejects.toThrow();
  });
  it("recovers a lost stage ACK by reading the exact block without sending it again", async () => {
    const f = uploadFixture(bytes.length); await f.store.create(f.input);
    f.setAfterWrite(kind => { if (kind === "stage") throw Error("FICTIONAL_ACK_LOST"); });
    await expect(f.store.chunk(f.input.operationId, 0, bytes)).rejects.toThrow();
    expect(f.state().pendingChunk).not.toBeNull();
    f.setAfterWrite(() => {}); await f.store.reconcileChunk(f.input.operationId);
    expect(f.state().chunks).toHaveLength(1); expect(f.state().pendingChunk).toBeNull();
    expect(f.calls.filter(c => c.startsWith("PUT:stage:"))).toHaveLength(1);
  });
  it("refuses a second write if the claimed block is absent after interruption", async () => {
    const f = uploadFixture(bytes.length); await f.store.create(f.input);
    f.setBeforeWrite(kind => { if (kind === "stage") throw Error("FICTIONAL_INTERRUPTED"); });
    await expect(f.store.chunk(f.input.operationId, 0, bytes)).rejects.toThrow();
    f.setBeforeWrite(() => {});
    await expect(f.store.chunk(f.input.operationId, 0, bytes)).rejects.toThrow();
    expect(f.calls.filter(c => c.startsWith("PUT:stage:"))).toHaveLength(1);
  });
  it("recovers commit ACK loss by properties and committed block order", async () => {
    const f = uploadFixture(bytes.length); await f.store.create(f.input); await f.store.chunk(f.input.operationId, 0, bytes);
    f.setAfterWrite(kind => { if (kind === "commit") throw Error("FICTIONAL_ACK_LOST"); });
    await expect(f.store.seal(f.input.operationId)).rejects.toThrow();
    f.setAfterWrite(() => {}); expect((await f.store.seal(f.input.operationId)).status).toBe("uploaded");
    expect(f.calls.filter(c => c.startsWith("PUT:commit:"))).toHaveLength(1);
  });
  it("retains one reservation across a lost state-create ACK", async () => {
    const f = uploadFixture(bytes.length);
    f.setAfterWrite((_kind, name) => { if (name.endsWith("state.json")) throw Error("FICTIONAL_ACK_LOST"); });
    await expect(f.store.create(f.input)).rejects.toThrow(); f.setAfterWrite(() => {});
    expect((await f.store.create(f.input)).status).toBe("preparing");
    await f.store.reconcileChunk(f.input.operationId); expect(f.state().status).toBe("uploading");
    expect(f.budget.reserveUpload).toHaveBeenCalledTimes(1);
  });
  it("rejects a public container before reservations or data writes", async () => {
    const f = uploadFixture(bytes.length); f.makePublic(); await expect(f.store.create(f.input)).rejects.toThrow();
    expect(f.budget.reserveUpload).not.toHaveBeenCalled(); expect(f.calls.some(c => c.startsWith("PUT:"))).toBe(false);
  });
  it("starts once and stores execution acknowledgement outside worker state", async () => {
    const f = await uploaded(); await startKohoUpload(f.store, f.input.operationId, f.arm);
    await startKohoUpload(f.store, f.input.operationId, f.arm);
    expect(f.arm.mock.calls.filter(c => c[1] === "POST")).toHaveLength(1);
    expect(f.state().executionId).toBeNull(); expect([...f.files.keys()].some(n => n.endsWith("job-accepted.json"))).toBe(true);
    const template = f.arm.mock.calls.find(c => c[1] === "POST")![2];
    expect(JSON.stringify(template)).not.toMatch(/AZURE_API_KEY|DATABASE_URL|MANAGED_WATCH_DATABASE_PASSWORD/);
  });
  it("classifies a budget claim failure without making or repeating an ARM POST", async () => {
    const f = await uploaded(); f.budget.claimUpload.mockRejectedValue(Error("FICTIONAL_BUDGET_UNKNOWN"));
    expect((await startKohoUpload(f.store, f.input.operationId, f.arm)).status).toBe("outcome_unknown");
    await startKohoUpload(f.store, f.input.operationId, f.arm);
    expect(f.arm.mock.calls.filter(c => c[1] === "POST")).toHaveLength(0); expect(f.budget.claimUpload).toHaveBeenCalledTimes(1);
  });
  it("keeps an unknown start reserved and never sends the POST again", async () => {
    const f = await uploaded(), initial = f.arm.getMockImplementation()!;
    f.arm.mockImplementation(async (url, method, body) => { if (method === "POST") throw Error("FICTIONAL_ARM_ACK_LOST"); return initial(url, method, body); });
    expect((await startKohoUpload(f.store, f.input.operationId, f.arm)).error).toBe("outcome_unknown");
    await startKohoUpload(f.store, f.input.operationId, f.arm);
    expect(f.arm.mock.calls.filter(c => c[1] === "POST")).toHaveLength(1); expect(f.budget.markUnknown).toHaveBeenCalledTimes(1);
  });
});
