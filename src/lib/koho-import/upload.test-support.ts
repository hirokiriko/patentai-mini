import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { BlobServiceClient } from "@azure/storage-blob";
import { vi } from "vitest";
import { managedBudgetPolicyFixture } from "../patent-watch/managed-budget-policy.test-support";
import { managedUploadBudgetRequest } from "../patent-watch/managed-execution-budget";
import { managedDigest } from "../patent-watch/managed-claims";
import { kohoUploadSettingsSchema, kohoUploadStateSchema, kohoUploadPrefix, type KohoUploadIntent } from "./upload-contract";
import { KohoUploadStorage } from "./upload-storage";
import type { KohoUploadArm } from "./upload-arm";

/** Real Azure SDK with an isolated in-memory HTTP transport. No network/keys. */
export function uploadFixture(byteLength = 8) {
  const { policy, binding } = managedBudgetPolicyFixture();
  policy.reservations.uploadJobYen = 80; policy.reservations.uploadGiBYen = 52;
  const pricingDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const settings = kohoUploadSettingsSchema.parse({ approval: "STANDARD_MANAGED_WATCH_RELEASE_V1", codeSha: policy.codeSha,
    job: { resourceId: policy.targets.jobResourceId, name: "fictional-manual", image: policy.image, databaseSecretRef: policy.targets.importDatabaseSecretRef },
    environmentResourceId: policy.targets.environmentResourceId, target: policy.targets.importTarget, budgetBinding: binding,
    maxBytes: 8 * 1024 ** 3, maxDatabaseBytes: 100 * 1024 ** 3, reservedGrowthBytes: 10 * 1024 ** 3 });
  const input = { operationId: randomUUID(), requestedAt: new Date().toISOString(), sourceAcquiredAt: null, fileName: "fictional.zip", byteLength };
  type File = { bytes: Buffer; etag: string; metadata: Record<string, string> };
  const files = new Map<string, File>(), blocks = new Map<string, Buffer>(), committed: string[] = [], calls: string[] = [];
  let revision = 0, publicContainer = false;
  let afterWrite: (kind: string, name: string, bytes: Buffer) => void = () => {};
  let beforeWrite: (kind: string, name: string, bytes: Buffer) => void = () => {};
  const reservations = new Map<string, string>();
  const budget = {
    prepareUpload: vi.fn(async (i: KohoUploadIntent) => {
      const request = managedUploadBudgetRequest(i, policy, binding, pricingDigest, null);
      return { ...i, serviceBudget: { serviceKey: policy.serviceKey, requestDigest: request.requestDigest, profileDigest: null, pricingDigest } };
    }),
    reserveUpload: vi.fn(async (i: KohoUploadIntent) => {
      const digest = managedDigest(i), previous = reservations.get(i.operationId);
      if (previous && previous !== digest) throw Error("FICTIONAL_CONFLICT");
      reservations.set(i.operationId, digest); return { created: !previous };
    }),
    beginUploadStaging: vi.fn(async () => {}),
    verifyUploadStaging: vi.fn(async (i: KohoUploadIntent) => ({ expiresAt: i.expiresAt, remainingMs: Date.parse(i.expiresAt) - Date.now() - 1000 })),
    confirmUpload: vi.fn(async () => {}), claimUpload: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}),
    verifyUpload: vi.fn(async (i: KohoUploadIntent) => ({ processingMonth: "2026-09", expiresAt: i.expiresAt, remainingMs: Date.parse(i.expiresAt) - Date.now() - 1000 })),
  };
  const service = new BlobServiceClient(`https://${binding.storageAccount}.blob.core.windows.net`,
    { async getToken() { return { token: "FICTIONAL_TOKEN", expiresOnTimestamp: Date.now() + 3600_000 }; } }, {
      retryOptions: { maxTries: 1 }, httpClient: { async sendRequest(req) {
        const u = new URL(req.url), name = decodeURIComponent(u.pathname.slice(binding.container.length + 2)), comp = u.searchParams.get("comp");
        const kind = req.method === "PUT" ? comp === "block" ? "stage" : comp === "blocklist" ? "commit" : "json" : "read";
        calls.push(`${req.method}:${kind}:${name}`);
        const headers = req.headers.clone(); for (const k of headers.headerNames()) headers.remove(k);
        headers.set("date", new Date().toUTCString()); headers.set("x-ms-request-id", "fictional"); headers.set("x-ms-version", "2025-11-05");
        let status = 200, bytes: Buffer = Buffer.alloc(0), bodyAsText: string | undefined;
        const error = (code: string, http: number) => { status = http; headers.set("x-ms-error-code", code);
          headers.set("content-type", "application/xml"); bodyAsText = `<Error><Code>${code}</Code></Error>`; };
        if (u.searchParams.get("restype") === "container") { if (publicContainer) headers.set("x-ms-blob-public-access", "blob"); }
        else if (req.method === "PUT") {
          const data = typeof req.body === "string" ? Buffer.from(req.body) : Buffer.from(req.body as Uint8Array);
          beforeWrite(kind, name, data);
          if (kind === "stage") {
            const blockId = u.searchParams.get("blockid")!;
            if (Buffer.from(blockId, "base64").length > 64 || req.headers.get("content-md5") !== createHash("md5").update(data).digest("base64")) error("InvalidMd5", 400);
            else { blocks.set(blockId, Buffer.from(data)); status = 201; }
          } else if (kind === "commit") {
            if (req.headers.get("if-none-match") !== "*" || files.has(name)) error("ConditionNotMet", 412);
            else {
              const ids = [...data.toString().matchAll(/<Latest>([^<]+)<\/Latest>/g)].map(m => m[1]);
              if (!ids.length || ids.some(id => !blocks.has(id))) error("InvalidBlockList", 400);
              else { committed.push(...ids); files.set(name, { bytes: Buffer.concat(ids.map(id => blocks.get(id)!)), etag: `"v${++revision}"`,
                metadata: { operation: req.headers.get("x-ms-meta-operation")!, blocks: req.headers.get("x-ms-meta-blocks")! } }); status = 201; }
            }
          } else {
            const exists = files.get(name), match = req.headers.get("if-match"), none = req.headers.get("if-none-match");
            if (none === "*" ? !!exists : !match || match !== exists?.etag) error("ConditionNotMet", 412);
            else { files.set(name, { bytes: Buffer.from(data), etag: `"v${++revision}"`, metadata: {} }); status = 201; }
          }
          if (status === 201) { headers.set("etag", files.get(name)?.etag ?? '"block"'); afterWrite(kind, name, data); }
        } else if (comp === "blocklist") {
          const list = (ids: string[]) => ids.map(id => `<Block><Name>${id}</Name><Size>${blocks.get(id)!.length}</Size></Block>`).join("");
          headers.set("content-type", "application/xml");
          bodyAsText = `<BlockList><CommittedBlocks>${list(committed)}</CommittedBlocks><UncommittedBlocks>${list([...blocks.keys()].filter(id => !committed.includes(id)))}</UncommittedBlocks></BlockList>`;
        } else {
          const file = files.get(name);
          if (!file) error("BlobNotFound", 404);
          else if (req.headers.get("if-match") && req.headers.get("if-match") !== file.etag) error("ConditionNotMet", 412);
          else {
            headers.set("etag", file.etag); headers.set("x-ms-blob-type", "BlockBlob");
            for (const [key, value] of Object.entries(file.metadata)) headers.set(`x-ms-meta-${key}`, value);
            bytes = file.bytes;
            const range = req.headers.get("x-ms-range") ?? req.headers.get("range");
            if (req.method === "GET" && range) {
              const match = /^bytes=(\d+)-(\d+)$/.exec(range); if (!match) throw Error("FICTIONAL_RANGE_INVALID");
              const start = Number(match[1]), end = Number(match[2]); bytes = bytes.subarray(start, end + 1); status = 206;
              headers.set("content-range", `bytes ${start}-${end}/${file.bytes.length}`);
            }
            headers.set("content-length", String(bytes.length));
          }
        }
        return { request: req, status, headers, bodyAsText, readableStreamBody: Readable.from(bytes) };
      } },
    });
  const container = service.getContainerClient(binding.container), signal = AbortSignal.timeout(60_000);
  const store = new KohoUploadStorage(settings, container, budget, signal);
  const arm = vi.fn<KohoUploadArm>(async (_url, method) => method === "GET" ? ({ status: 200, body: {
    id: settings.job.resourceId, properties: { environmentId: settings.environmentResourceId,
      configuration: { triggerType: "Manual", replicaRetryLimit: 0, replicaTimeout: 7200, manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 } },
      template: { containers: [{ image: settings.job.image }] } } } }) : ({ status: 200, body: {
    name: settings.job.name + "-fictional", id: settings.job.resourceId + "/executions/" + settings.job.name + "-fictional" } }));
  return { input, settings, policy, binding, budget, store, arm, files, blocks, calls, signal,
    setAfterWrite: (fn: typeof afterWrite) => { afterWrite = fn; }, setBeforeWrite: (fn: typeof beforeWrite) => { beforeWrite = fn; },
    makePublic: () => { publicContainer = true; }, state: () => kohoUploadStateSchema.parse(JSON.parse(files.get(kohoUploadPrefix(input.operationId) + "state.json")!.bytes.toString())) };
}
