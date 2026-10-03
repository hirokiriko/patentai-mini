import { createHash } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { cloudSourceName, parseCloudManifest, isManagedCloudManifest, sha256, type CloudConfiguration, type CloudManifest } from "./cloud-config";
import { requireManual } from "./manual-cli-config";
import { managedDigest } from "../patent-watch/managed-claims";

type Package = Extract<CloudManifest, { approval: "STANDARD_MANAGED_WATCH_RELEASE_V1" }>["packages"][number];
export const archiveReceiptName = (operationId: string) => `receipts/${z.uuidv4().parse(operationId)}/archive-verified.json`;
export function archivePackageIdentity(pkg: Package) {
  const { etag, archive, expectedDisposition, ...identity } = pkg; void etag; void archive; void expectedDisposition;
  requireManual(pkg.acquiredAt); return identity;
}
export async function archiveRead(container: ContainerClient, name: string, maximum = 131072) {
  const blob = container.getBlobClient(name), signal = AbortSignal.timeout(20_000);
  let props;
  try { props = await blob.getProperties({ abortSignal: signal }); }
  catch (e) { if (isAzureBlobNotFound(e)) return null; throw e; }
  requireManual(props.etag && props.contentLength && props.contentLength <= maximum && !props.contentEncoding);
  const response = await blob.download(0, undefined, { conditions: { ifMatch: props.etag }, abortSignal: signal, maxRetryRequests: 0 });
  requireManual(response.etag === props.etag && response.contentLength === props.contentLength && !response.contentEncoding && response.readableStreamBody);
  const parts: Buffer[] = []; let bytes = 0;
  try { for await (const chunk of response.readableStreamBody) { const b = Buffer.from(chunk); bytes += b.length; requireManual(bytes <= props.contentLength); parts.push(b); } }
  finally { response.readableStreamBody.destroy(); }
  requireManual(bytes === props.contentLength); signal.throwIfAborted();
  const data = Buffer.concat(parts); return { data, props, value: JSON.parse(data.toString("utf8")) as unknown };
}
/** Verify the exact committed Azure bytes without making a second Local ZIP. */
export async function verifyArchiveBytes(container: ContainerClient, pkg: Pick<Package, "sha256" | "byteLength" | "etag">, maximumMs=15*60_000) {
  requireManual(Number.isSafeInteger(maximumMs)&&maximumMs>0&&maximumMs<=15*60_000);
  const signal = AbortSignal.timeout(maximumMs), blob = container.getBlobClient(cloudSourceName(pkg.sha256));
  const props = await blob.getProperties({ conditions: { ifMatch: pkg.etag }, abortSignal: signal });
  requireManual(props.etag === pkg.etag && props.contentLength === pkg.byteLength && !props.contentEncoding);
  const response = await blob.download(0, undefined, { conditions: { ifMatch: pkg.etag }, abortSignal: signal, maxRetryRequests: 0 });
  requireManual(response.etag === pkg.etag && response.contentLength === pkg.byteLength && !response.contentEncoding && response.readableStreamBody);
  const hash = createHash("sha256"); let bytes = 0;
  try { for await (const chunk of response.readableStreamBody) { const b = Buffer.from(chunk); bytes += b.length; requireManual(bytes <= pkg.byteLength); hash.update(b); signal.throwIfAborted(); } }
  finally { response.readableStreamBody.destroy(); }
  requireManual(bytes === pkg.byteLength && hash.digest("hex") === pkg.sha256); signal.throwIfAborted();
}
const receiptSchema = z.object({ schema: z.literal(1), operationId: z.uuidv4(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/), blobName: z.string(), etag: z.string(),
  verifiedAt: z.iso.datetime(), identity: z.unknown() }).strict();
export async function readVerifiedArchive(container: ContainerClient, config: CloudConfiguration, pkg: Package) {
  requireManual(pkg.archive && pkg.acquiredAt);
  const ref = pkg.archive, saved = await archiveRead(container, `manifests/${ref.operationId}.json`);
  requireManual(saved && sha256(saved.data) === ref.manifestSha256);
  const raw = saved.value as { mode?: unknown; codeSha?: unknown; approval?: unknown };
  const archiveConfig = { ...config, approval: raw.approval, operationId: ref.operationId, mode: raw.mode, expectedCodeSha: raw.codeSha,
    manifest: { sha256: ref.manifestSha256, byteLength: saved.data.length, etag: saved.props.etag! } } as CloudConfiguration;
  const manifest = parseCloudManifest(saved.data, archiveConfig, Date.now(), false);
  requireManual(isManagedCloudManifest(manifest) && manifest.archiveOnly && manifest.packages.length === 1);
  const original = manifest.packages[0];
  requireManual(original.etag === pkg.etag && managedDigest(archivePackageIdentity(original)) === managedDigest(archivePackageIdentity(pkg)));
  const stored = await archiveRead(container, archiveReceiptName(ref.operationId));
  requireManual(stored && sha256(stored.data) === ref.receiptSha256);
  const receipt = receiptSchema.parse(stored.value);
  requireManual(receipt.operationId === ref.operationId && receipt.blobName === cloudSourceName(pkg.sha256) && receipt.etag === pkg.etag &&
    receipt.identityDigest === managedDigest(archivePackageIdentity(pkg)) && managedDigest(receipt.identity) === receipt.identityDigest &&
    Date.parse(pkg.acquiredAt) <= Date.parse(receipt.verifiedAt));
  const props = await container.getBlobClient(receipt.blobName).getProperties({ conditions: { ifMatch: receipt.etag }, abortSignal: AbortSignal.timeout(20_000) });
  requireManual(props.etag === receipt.etag && props.contentLength === pkg.byteLength && !props.contentEncoding);
  return { receipt, manifest };
}
export const archiveVerificationContinuationSchema=z.object({localCodeSha:z.string().regex(/^[a-f0-9]{40}$/),
  priorFailureSha256:z.string().regex(/^[a-f0-9]{64}$/),priorSenderTerminated:z.literal(true),markerSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function confirmArchiveReceipt(container: ContainerClient, config: CloudConfiguration, pkg: Package, reconcile = false, guard = () => {}, continuation?:z.infer<typeof archiveVerificationContinuationSchema>) {
  requireManual("serviceBudget" in config && config.serviceBudget && pkg.acquiredAt);
  requireManual(Date.parse(pkg.acquiredAt) <= Date.now());
  const identity = archivePackageIdentity(pkg), name = archiveReceiptName(config.operationId);
  const expected = { schema: 1, operationId: config.operationId, requestDigest: config.serviceBudget.requestDigest,
    identityDigest: managedDigest(identity), blobName: cloudSourceName(pkg.sha256), etag: pkg.etag, identity };
  const before = await archiveRead(container, name);
  if (!before) {
    // A single create-only slot bounds full-byte verification, including failed
    // or concurrent attempts. Existing verified receipts only need metadata reads.
    const slot = Buffer.from(JSON.stringify({ operationId: config.operationId, identityDigest: expected.identityDigest, etag: pkg.etag }));
    let maximumMs=15*60_000;
    if(continuation){
      const proof=archiveVerificationContinuationSchema.parse(continuation);requireManual(reconcile);
      const prior=await archiveRead(container,`receipts/${config.operationId}/archive-verification-recovery-started.json`);
      requireManual(prior&&sha256(prior.data)===proof.markerSha256&&prior.data.equals(slot)&&prior.props.createdOn instanceof Date);
      const deadline=prior.props.createdOn.getTime()+15*60_000;
      maximumMs=deadline-Date.now();requireManual(maximumMs>20_000&&maximumMs<=15*60_000);
      guard();await container.getBlockBlobClient(`receipts/${config.operationId}/archive-verification-continuation-started.json`).uploadData(Buffer.from(JSON.stringify({
        ...proof,operationId:config.operationId,identityDigest:expected.identityDigest,etag:pkg.etag,verifyNotAfter:new Date(deadline).toISOString()})),{
        conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20_000),blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"private, no-store"}});
      maximumMs=deadline-Date.now();
    }else{guard();await container.getBlockBlobClient(`receipts/${config.operationId}/archive-verification${reconcile ? "-recovery" : ""}-started.json`).uploadData(slot, {
      conditions: { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(20_000),
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });}
    guard();await verifyArchiveBytes(container,pkg,maximumMs);guard();
    const bytes = Buffer.from(JSON.stringify({ ...expected, verifiedAt: new Date().toISOString() }));
    await container.getBlockBlobClient(name).uploadData(bytes, { conditions: { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(20_000),
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
  }
  const saved = await archiveRead(container, name); requireManual(saved);
  const { verifiedAt, ...actual } = receiptSchema.parse(saved.value); void verifiedAt;
  requireManual(managedDigest(actual) === managedDigest(expected));
  return sha256(saved.data);
}
import { isAzureBlobNotFound } from "../azure-blob-errors";
