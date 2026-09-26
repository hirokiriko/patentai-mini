import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { AnonymousCredential, BlobServiceClient, newPipeline } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import { ManagedPrivateStorage, reconcileManagedDelivery, storeManagedDelivery, createManagedDelivery } from "./managed-storage";
import { artifactAdmissionFixture } from "./managed-artifact.test-support";
import type { ManagedArtifactManifest } from "./managed-storage";
import type { ManagedDeliveryRepository } from "../../repositories/managed-delivery";
import { managedDeliveryFixture } from "./managed-delivery.test-support";

function boundary() {
  const files = new Map<string, Buffer>(), requests: { method: string; path: string }[] = [];
  let publicContainer = false, failPdf = false, wrongBytes = false;
  const pipeline = newPipeline(new AnonymousCredential(), { retryOptions: { maxTries: 1 }, httpClient: {
    async sendRequest(request) {
      const url = new URL(request.url), path = url.pathname;
      requests.push({ method: request.method, path });
      const headers = request.headers.clone();
      for (const header of headers.headerNames()) headers.remove(header);
      headers.set("x-ms-request-id", "fictional-request"); headers.set("x-ms-version", "2025-11-05");
      let status = 200, body = Buffer.alloc(0);
      if (url.searchParams.get("restype") === "container") { if (publicContainer) headers.set("x-ms-blob-public-access", "blob"); }
      else if (request.method === "PUT") {
        expect(request.headers.get("if-none-match")).toBe("*");
        if (failPdf && path.endsWith("/pdf.pdf")) throw Error("FICTIONAL_PRIVATE_SENTINEL");
        if (files.has(path)) status = 412;
        else { files.set(path, Buffer.from(request.body as Uint8Array)); status = 201; }
      } else if (!files.has(path)) { status = 404; headers.set("x-ms-error-code", "BlobNotFound"); headers.set("content-type", "application/xml"); }
      else { body = Buffer.from(files.get(path)!); if (wrongBytes) body[0] ^= 1; headers.set("etag", '"fixture-etag"'); headers.set("content-length", String(body.length)); }
      return { request, status, headers, readableStreamBody: Readable.from(body), bodyAsText: status >= 400 ? request.method === "HEAD" ? "" : "<?xml version=\"1.0\"?><Error><Code>BlobNotFound</Code><Message>fictional absent</Message></Error>" : undefined };
    },
  } });
  const storage = new ManagedPrivateStorage(new BlobServiceClient("https://fictional.blob.core.windows.net", pipeline).getContainerClient("private"));
  const report = managedDeliveryFixture(), state: { status: string; manifest: ManagedArtifactManifest | null } = { status: "prepared", manifest: null };
  let lostCommitAck = false;
  const repository = {
    prepare:vi.fn(async()=>report),
    async reserveArtifacts(_report: unknown, manifest: ManagedArtifactManifest) { if (state.manifest) throw Error(); state.manifest = manifest; },
    async markArtifacts(_report: unknown, _manifest: unknown, status: string) { state.status = status; if (status === "stored" && lostCommitAck) throw Error("lost ACK"); },
    async get() { return { report, ...state }; },
  } as unknown as ManagedDeliveryRepository;
  return { report, repository, storage, state, requests, files,
    setPublic: () => { publicContainer = true; }, failPdf: () => { failPdf = true; }, corrupt: () => { wrongBytes = true; }, loseCommitAck: () => { lostCommitAck = true; } };
}
describe("actual Blob SDK bounded delivery storage with fake HTTP transport", { timeout: 30_000 }, () => {
  const input=(b:ReturnType<typeof boundary>)=>({kind:"delivery" as const,caseId:b.report.caseId,deliveryId:b.report.deliveryId,
    period:b.report.period,distributionTableSha256:"a".repeat(64),reason:"initial" as const,deliveredOn:null});
  it("admits before DB preparation and retains the one claim after a partial write",async()=>{
    const b=boundary(),budget=artifactAdmissionFixture();b.failPdf();
    await expect(createManagedDelivery(b.repository,b.storage,input(b),AbortSignal.timeout(90_000),budget.admit)).rejects.toThrow("outcome_unknown");
    expect(budget.records.size).toBe(1);expect(b.repository.prepare).toHaveBeenCalledTimes(1);
    await expect(createManagedDelivery(b.repository,b.storage,input(b),AbortSignal.timeout(90_000),budget.admit)).rejects.toThrow("conflict");
    expect(b.repository.prepare).toHaveBeenCalledTimes(1);expect(b.requests.filter(r=>r.method==="PUT")).toHaveLength(2);
    expect(await reconcileManagedDelivery(b.repository,b.storage,b.report.caseId,b.report.deliveryId)).toBe("storage_unknown");
    expect(budget.records.size).toBe(1);expect(b.requests.filter(r=>r.method==="PUT")).toHaveLength(2);
  });
  it.each(["refused","expired","lost-ack"])("does not prepare or write a delivery after budget %s",async mode=>{
    const b=boundary(),controller=new AbortController();
    const admit=async()=>{if(mode==="expired")controller.abort();else throw Error("reconciliation_required");};
    await expect(createManagedDelivery(b.repository,b.storage,input(b),controller.signal,admit)).rejects.toThrow();
    expect(b.repository.prepare).not.toHaveBeenCalled();expect(b.requests).toEqual([]);
  });
  it("stores immutable exact bytes and rereads them without AI or uploads", async () => {
    const b = boundary(), manifest = await storeManagedDelivery(b.repository, b.storage, b.report);
    expect(b.state.status).toBe("stored"); expect(b.requests.filter(r => r.method === "PUT")).toHaveLength(3);
    for (const artifact of manifest.artifacts) expect(createHash("sha256").update(await b.storage.read(manifest, artifact.kind)).digest("hex")).toBe(artifact.sha256);
    expect(b.requests.filter(r => r.method === "PUT")).toHaveLength(3);
    b.corrupt(); await expect(b.storage.read(manifest, "snapshot")).rejects.toThrow("unavailable");
  });
  it("reads back a lost stored ACK without downgrading state or uploading again", async () => {
    const b = boundary(); b.loseCommitAck(); await storeManagedDelivery(b.repository, b.storage, b.report);
    expect(b.state.status).toBe("stored"); expect(b.requests.filter(r => r.method === "PUT")).toHaveLength(3);
  });
  it("reconciles partial storage and explicitly abandons it without resending any write", async () => {
    const b = boundary(); b.failPdf(); await expect(storeManagedDelivery(b.repository, b.storage, b.report)).rejects.toThrow("outcome_unknown");
    expect(b.state.status).toBe("storage_unknown");
    expect(await reconcileManagedDelivery(b.repository, b.storage, 7, b.report.deliveryId)).toBe("storage_unknown");
    expect(await reconcileManagedDelivery(b.repository, b.storage, 7, b.report.deliveryId, true)).toBe("abandoned");
    expect(b.requests.filter(r => r.method === "PUT")).toHaveLength(2);
  });
  it("fails closed on a public container before uploading bytes", async () => {
    const b = boundary(); b.setPublic(); await expect(storeManagedDelivery(b.repository, b.storage, b.report)).rejects.toThrow("outcome_unknown");
    expect(b.requests.filter(r => r.method === "PUT")).toHaveLength(0);
  });
});
