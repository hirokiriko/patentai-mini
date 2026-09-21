import { chmod, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseKohoPackage } from "../koho-package";
import { buildKohoImportPlan } from "./builder";
import { buildKohoManualImportLimits } from "./manual-api";
import { requireManual } from "./manual-cli-config";
import { verifyManualSnapshot } from "./manual-cli-source";
import { projectManualResult, summarizeManualPackage, type ManualFileResult } from "./manual-cli-summary";
import { cloudManifestName, cloudPlanSha256, cloudReceiptPrefix, cloudSourceName, parseCloudConfiguration, parseCloudManifest,
  type CloudConfiguration } from "./cloud-config";
import type { CloudBlobBoundary } from "./cloud-blob";
import { saveCloudPlan } from "./cloud-db";
import { updatePackageMetadata } from "./update-check";

/** Conditional ETag updates preserve an append-only logical prefix; ambiguous ACK stops all later writes. */
class CloudReceipt {
  private bytes = Buffer.alloc(0);
  private etag?: string;
  private sequence = 0;
  constructor(private readonly blob: CloudBlobBoundary, private readonly config: CloudConfiguration) {}
  async record(type: string, fields: Record<string, unknown>) {
    const line = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: this.config.operationId,
      sequence: ++this.sequence, type, observedAt: new Date().toISOString(), ...fields }) + "\n");
    requireManual(line.length <= 16 * 1024 && this.bytes.length + line.length <= 1024 * 1024);
    this.bytes = Buffer.concat([this.bytes, line]);
    const name = cloudReceiptPrefix(this.config) + "receipt.jsonl";
    this.etag = this.etag ? await this.blob.replace(name, this.bytes, this.etag) : await this.blob.create(name, this.bytes);
  }
}

export async function runCloudImport(value: unknown, blob: CloudBlobBoundary, options: {
  password?: string; signal?: AbortSignal; save?: typeof saveCloudPlan;
} = {}) {
  const started = performance.now(), config = parseCloudConfiguration(value);
  let receiptAcknowledgement: "confirmed" | "unconfirmed" = "unconfirmed", cleanup: "complete" | "required" = "complete";
  let receiptFailed = false, startedAcknowledged = false, stopped = false, capacityConfirmed = true, capacityObserved = false, growth = 0;
  const results: ManualFileResult[] = [];
  try {
    await blob.assertPrivate();
    const manifest = parseCloudManifest(await blob.read(cloudManifestName(config), config.manifest.byteLength, config.manifest.etag), config);
    requireManual(config.mode === "preview" || (typeof options.password === "string" && options.password.length > 0));
    const deadline = started + manifest.maxElapsedMs;
    const guard = () => requireManual(!options.signal?.aborted && performance.now() < deadline && Date.now() < Date.parse(manifest.expiresAt));
    guard();
    // A lost marker ACK still prevents replay. Never retry this operation ID automatically.
    await blob.create(cloudReceiptPrefix(config) + "started.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
      operationId: config.operationId, mode: config.mode, codeSha: config.expectedCodeSha, manifestSha256: config.manifest.sha256,
      target: config.expectedTarget, environmentResourceId: config.expectedEnvironmentResourceId, round: manifest.round,
      inputs: manifest.packages, status: "started", observedAt: new Date().toISOString() })));
    startedAcknowledged = true;
    const receipt = new CloudReceipt(blob, config);
    await receipt.record("batch_started", { mode: config.mode, fileCount: manifest.packages.length,
      files: manifest.packages.map((p, i) => ({ ordinal: i + 1, packageType: p.packageType })) });
    for (const [index, pkg] of manifest.packages.entries()) {
      const result: ManualFileResult = { ordinal: index + 1, packageType: pkg.packageType, outcome: "not_processed", savedDocumentCount: 0, includesReviewRequired: false };
      results.push(result);
      let directory: string | undefined, saving = false, verified = false;
      if (!stopped) {
        result.outcome = "failed_before_save";
        try {
          guard(); const parent = resolve(tmpdir()); directory = await mkdtemp(join(parent, "koho-cloud-"));
          requireManual(dirname(directory) === parent); await chmod(directory, 0o700);
          const source = join(directory, "source.zip");
          requireManual(await blob.download(cloudSourceName(pkg.sha256), pkg.byteLength, pkg.etag, source) === pkg.sha256);
          guard(); await verifyManualSnapshot(source, pkg.byteLength, pkg.sha256);
          const parsed = await parseKohoPackage({ packageType: pkg.packageType, source: { type: "file", path: source },
            limits: buildKohoManualImportLimits(pkg.byteLength) });
          const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: pkg.sha256 });
          const metadata = updatePackageMetadata(parsed);
          requireManual(metadata.date === pkg.publicationDate && metadata.issue === pkg.issueNumber && metadata.notes.length === 0);
          guard(); await verifyManualSnapshot(source, pkg.byteLength, pkg.sha256);
          requireManual(cloudPlanSha256(plan) === pkg.planSha256 && plan.documentCount === pkg.documentCount &&
            plan.packageStatus !== "failed" && !(plan.documentCount === 0 && plan.packageStatus === "review_required") &&
            (plan.packageStatus === "review_required") === pkg.expectedReviewRequired &&
            plan.documents.every(d => d.publicationDate.replaceAll("-", "") === pkg.publicationDate.replaceAll("-", "")));
          result.summary = summarizeManualPackage(parsed, plan);
          try { await receipt.record("input_verified", { ordinal: index + 1, packageType: pkg.packageType, byteLength: pkg.byteLength, sha256: pkg.sha256 }); }
          catch { receiptFailed = true; throw Error("cloud_receipt_stopped"); }
          verified = true; guard();
          if (config.mode === "preview") result.outcome = "preview_not_saved";
          else if (plan.packageStatus === "review_required" && !manifest.allowReviewRequired) result.outcome = "review_not_saved";
          else {
            requireManual(growth < manifest.reservedGrowthBytes);
            const saved = await (options.save ?? saveCloudPlan)(config, { ...manifest, reservedGrowthBytes: manifest.reservedGrowthBytes - growth }, options.password!, plan,
              () => { guard(); saving = true; result.outcome = "save_outcome_unknown"; });
            result.outcome = saved.outcome; result.savedDocumentCount = saved.savedDocumentCount;
            result.includesReviewRequired = ["inserted", "reused"].includes(saved.outcome) && plan.packageStatus === "review_required";
            growth += saved.databaseGrowthBytes; capacityObserved = true; capacityConfirmed &&= saved.capacityConfirmed;
            if (!saved.capacityConfirmed) stopped = true;
          }
        } catch {
          // Receipt/capacity failures cannot retroactively change an acknowledged DB result.
          if (!["inserted", "reused"].includes(result.outcome)) result.outcome = saving ? "save_outcome_unknown" : "failed_before_save";
          stopped = true;
        } finally {
          if (!verified) delete result.summary;
          if (directory) {
            try { requireManual(dirname(directory) === resolve(tmpdir()) && directory.startsWith(join(resolve(tmpdir()), "koho-cloud-")));
              await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
            catch { cleanup = "required"; stopped = true; }
          }
        }
        if (!["preview_not_saved", "inserted", "reused"].includes(result.outcome)) stopped = true;
      }
      if (!receiptFailed) {
        const { summary, ...fields } = projectManualResult(result, index + 1, pkg.packageType);
        try { await receipt.record("file_finished", { ...fields, cleanup, ...(summary ? { summary: { ...summary,
          publicationDates: { scope: summary.publicationDates.scope, min: summary.publicationDates.min, max: summary.publicationDates.max } } } : {}) }); }
        catch { receiptFailed = true; stopped = true; }
      }
    }
    if (!receiptFailed) {
      const status = results.some(r => r.outcome === "save_outcome_unknown") ? "reconciliation_required" : stopped ? "stopped" : "complete";
      await receipt.record("batch_finished", { status, cleanup, savedRecordCount: results.reduce((n, r) => n + (r.outcome === "inserted" ? r.savedDocumentCount : 0), 0) });
      // Both completion object and receipt remain private and conditional; a missing ACK stays explicit.
      await blob.create(cloudReceiptPrefix(config) + "finished.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
        operationId: config.operationId, manifestSha256: config.manifest.sha256, target: config.expectedTarget,
        environmentResourceId: config.expectedEnvironmentResourceId, codeSha: config.expectedCodeSha, round: manifest.round,
        status, cleanup, capacityConfirmed: capacityObserved && capacityConfirmed, databaseGrowthBytes: growth,
        databaseResults: results.map(r => ({ ordinal: r.ordinal, outcome: r.outcome,
          commitAcknowledgement: ["inserted", "reused"].includes(r.outcome) ? "confirmed" : r.outcome === "save_outcome_unknown" ? "unconfirmed" : "not_committed",
          savedDocumentCount: r.savedDocumentCount, includesReviewRequired: r.includesReviewRequired })), observedAt: new Date().toISOString() })));
      receiptAcknowledgement = "confirmed";
    }
  } catch { stopped = true; }
  const complete = !stopped && receiptAcknowledgement === "confirmed" && cleanup === "complete" && results.length > 0;
  return { status: complete ? "complete" : "reconciliation_required", receiptAcknowledgement, startedAcknowledged, cleanup,
    capacityConfirmed: capacityObserved && capacityConfirmed, databaseGrowthBytes: growth, elapsedMs: Math.ceil(performance.now() - started), peakRssKiB: process.resourceUsage().maxRSS,
    results: results.map(r => ({ ordinal: r.ordinal, packageType: r.packageType, outcome: r.outcome,
      savedDocumentCount: r.savedDocumentCount, includesReviewRequired: r.includesReviewRequired })), exitCode: complete ? 0 : 2 };
}
