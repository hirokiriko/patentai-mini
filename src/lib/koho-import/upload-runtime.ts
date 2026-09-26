import { randomUUID } from "node:crypto";
import { parseKohoPackage } from "../koho-package";
import { acquireManagedDistribution, managedDistributionRows } from "../patent-watch/managed-distribution";
import { managedDigest } from "../patent-watch/managed-claims";
import { kohoUploadIntentSchema, kohoUploadPrefix } from "./upload-contract";
import { KohoUploadStorage } from "./upload-storage";
import { verifiedUploadSource } from "./upload-source";
import { buildManagedImportLimits } from "./managed-limits";
import { buildKohoImportPlan } from "./builder";
import { projectManagedPackage } from "./managed-package";
import { cloudPlanSha256 } from "./cloud-config";
import { saveUploadedCloudPlan } from "./cloud-db";
import { requireManual } from "./manual-cli-config";
import { uploadArchiveSchema, uploadFinishedSchema, uploadResultSchema } from "./upload-receipts";

/** Executes only inside the existing bounded Manual Job. No polling loop,
 * detached server work, DB credential in the browser, or generic task system. */
export async function runKohoUpload(value: unknown, store: KohoUploadStorage, password: string, signal: AbortSignal,
  dependencies: { save?: typeof saveUploadedCloudPlan; distribution?: typeof acquireManagedDistribution } = {}) {
  const intent = kohoUploadIntentSchema.parse(value), id = intent.operationId;
  let saved = await store.read(id), mayHaveSaved = false;
  requireManual(managedDigest(saved.state.intent) === managedDigest(intent) && saved.state.source && saved.state.startClaimed &&
    ["submitting", "outcome_unknown"].includes(saved.state.status));
  const permit = await store.budget.verifyUpload(intent);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.min(115 * 60_000, Math.floor(permit.remainingMs)))]);
  const startedAt = performance.now();
  const options = () => { deadline.throwIfAborted(); return { abortSignal: AbortSignal.any([deadline, AbortSignal.timeout(20_000)]) }; };
  async function readJson(name: string, maximum: number) {
    const blob = store.container.getBlobClient(name), p = await blob.getProperties(options());
    requireManual(p.contentLength && p.contentLength <= maximum && p.etag && !p.contentEncoding);
    const r = await blob.download(0, p.contentLength, { ...options(), conditions: { ifMatch: p.etag }, maxRetryRequests: 0 });
    requireManual(r.contentLength === p.contentLength && r.etag === p.etag && r.readableStreamBody);
    let bytes = 0; const parts: Buffer[] = [];
    try { for await (const c of r.readableStreamBody!) { const b = Buffer.from(c); bytes += b.length; requireManual(bytes <= maximum); parts.push(b); } }
    finally { r.readableStreamBody!.destroy(); }
    requireManual(bytes === p.contentLength); return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  }
  async function createExact(name: string, record: unknown, maximum = 128 * 1024) {
    const bytes = Buffer.from(JSON.stringify(record)); requireManual(bytes.length <= maximum);
    try { await store.container.getBlockBlobClient(name).uploadData(bytes, { ...options(), conditions: { ifNoneMatch: "*" },
      maxSingleShotSize: maximum, concurrency: 1, blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } }); }
    catch { requireManual(managedDigest(await readJson(name, maximum)) === managedDigest(record)); }
    requireManual(managedDigest(await readJson(name, maximum)) === managedDigest(record));
  }
  const prefix = kohoUploadPrefix(id), nonce = randomUUID();
  await createExact(prefix + "worker-started.json", { schema: 1, operationId: id, nonce,
    intentDigest: managedDigest(intent), source: saved.state.source, codeSha: intent.settings.codeSha });
  try {
    // The create-only nonce admits this worker exactly once. Re-read the state
    // after the marker so a lost ARM ACK cannot leave us using an old ETag.
    for (let attempt = 0; attempt < 2; attempt++) {
      saved = await store.read(id);
      requireManual(saved.state.startClaimed && saved.state.source && managedDigest(saved.state.intent) === managedDigest(intent) &&
        ["submitting", "outcome_unknown", "processing"].includes(saved.state.status));
      if (saved.state.status === "processing") break;
      try { saved = await store.replace(saved, { ...saved.state, status: "processing", error: null }); break; }
      catch { if (attempt === 1) { saved = await store.read(id); requireManual(saved.state.status === "processing"); } }
    }
    const source = saved.state.source!;
    const verified = await verifiedUploadSource(store.sourceBlob(id), source, deadline);
    const parsed = await parseKohoPackage({ packageType: "JPA", source: verified.source, limits: buildManagedImportLimits(source.byteLength) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: verified.sha256 });
    requireManual(plan.packageStatus !== "failed" && !(plan.packageStatus === "review_required" && plan.documentCount === 0));
    const managed = projectManagedPackage(parsed, plan), receipt = managed.receipt;
    const distribution = await (dependencies.distribution ?? acquireManagedDistribution)();
    const rows = managedDistributionRows(distribution, { from: receipt.publicationDate, to: receipt.publicationDate });
    const row = rows.find(r => r.issueNumber === receipt.issueNumber);
    requireManual(row?.available && row.cumulativeIssue === receipt.cumulativeIssue &&
      row.publishedCount === receipt.publishedCount + receipt.publishedAmendments &&
      row.translatedCount === receipt.translatedCount + receipt.translatedAmendments &&
      plan.documents.every(d => d.publicationDate === receipt.publicationDate));
    requireManual((await store.sourceBlob(id).getProperties(options())).etag === source.etag);
    await createExact(prefix + "distribution.json", distribution, 2 * 1024 * 1024);
    const archive = uploadArchiveSchema.parse({ schema: 1, operationId: id, packageType: "JPA", source: { blobName: prefix + "source.zip", ...source, sha256: verified.sha256 },
      publicationDate: receipt.publicationDate, issueNumber: receipt.issueNumber, distributionTableSha256: distribution.sha256,
      receivedAt: intent.receivedAt, sourceAcquiredAt: intent.sourceAcquiredAt, verifiedAt: new Date().toISOString(), codeSha: intent.settings.codeSha,
      planSha256: cloudPlanSha256(plan), managedSourcesSha256: managed.managedSourcesSha256,
      managedReceiptSha256: managed.managedReceiptSha256, documentCount: plan.documentCount });
    await createExact(prefix + "verified-archive.json", archive);
    // Each sealed source is retained as its private immutable original. Source
    // SHA deduplication is enforced by the existing transactional repository.
    const result = await (dependencies.save ?? saveUploadedCloudPlan)({ mode: "apply", approval: intent.settings.approval,
      expectedTarget: intent.settings.target }, { expiresAt: permit.expiresAt, maxElapsedMs: 115 * 60_000,
      maxDatabaseBytes: intent.settings.maxDatabaseBytes, reservedGrowthBytes: intent.settings.reservedGrowthBytes,
      packages: [{ packageType: "JPA", sha256: verified.sha256, expectedDisposition: "inserted" }] }, password, plan,
      () => { deadline.throwIfAborted(); mayHaveSaved = true; }, undefined, managed,
      { deadline: startedAt + Math.min(115 * 60_000, permit.remainingMs), signal: deadline });
    requireManual(["inserted", "reused"].includes(result.outcome) && result.capacityConfirmed && result.savedDocumentCount === plan.documentCount);
    const display = uploadResultSchema.parse({ disposition: result.outcome,
      documentCount: plan.documentCount, completeClaims: managed.sources.filter(s => s.status === "complete").length,
      incompleteClaims: managed.sources.filter(s => s.status !== "complete").length,
      publicationDate: receipt.publicationDate, issueNumber: receipt.issueNumber });
    const finished = uploadFinishedSchema.parse({ schema: 1, operationId: id, intentDigest: managedDigest(intent), archiveDigest: managedDigest(archive),
      sourceSha256: verified.sha256, result: display,
      databaseGrowthBytes: result.databaseGrowthBytes, managedReceiptSha256: managed.managedReceiptSha256,
      completedAt: new Date().toISOString() });
    await createExact(prefix + "finished.json", finished);
    saved = await store.read(id);
    await store.replace(saved, { ...saved.state, status: "complete", result: { ...display, receiptSha256: managedDigest(finished) }, error: null });
    return { status: "complete", exitCode: 0 };
  } catch {
    await store.budget.markUnknown(id).catch(() => undefined);
    try {
      saved = await store.read(id);
      if (saved.state.status !== "complete") await store.replace(saved, { ...saved.state,
        status: mayHaveSaved ? "outcome_unknown" : "failed", error: mayHaveSaved ? "outcome_unknown" : "verification_failed" });
    } catch { /* Durable intent/worker marker still prevents a second start. */ }
    return { status: "reconciliation_required", exitCode: 2 };
  }
}
