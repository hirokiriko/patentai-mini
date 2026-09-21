/** Entirely fictional operator input and in-memory Blob transport for the dedicated entrypoint. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoImportPlan } from "../src/lib/koho-import/builder";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { cloudManifestName, cloudPlanSha256, cloudSourceName, sha256, type CloudConfiguration, type CloudManifest } from "../src/lib/koho-import/cloud-config";
import type { CloudBlobBoundary } from "../src/lib/koho-import/cloud-blob";
import { manualFixture } from "./koho-manual-import-fixtures";

export class FictionalCloudBlob implements CloudBlobBoundary {
  readonly objects = new Map<string, { bytes: Buffer; etag: string }>();
  private sequence = 1;
  fail: (name: string, write: boolean) => boolean = () => false;
  private = true;
  async assertPrivate() { if (!this.private) throw Error("FICTIONAL_PRIVATE_ERROR"); }
  async read(name: string, bytes: number, etag: string) {
    const value = this.objects.get(name);
    if (this.fail(name, false) || !value || value.bytes.length !== bytes || value.etag !== etag) throw Error("FICTIONAL_PRIVATE_ERROR");
    return Buffer.from(value.bytes);
  }
  async download(name: string, bytes: number, etag: string, path: string) {
    const data = await this.read(name, bytes, etag); await writeFile(path, data, { flag: "wx", mode: 0o600 }); return sha256(data);
  }
  async create(name: string, bytes: Buffer) {
    if (this.fail(name, true) || this.objects.has(name)) throw Error("FICTIONAL_PRIVATE_ERROR");
    const etag = `"${++this.sequence}"`; this.objects.set(name, { bytes: Buffer.from(bytes), etag }); return etag;
  }
  async replace(name: string, bytes: Buffer, etag: string) {
    if (this.fail(name, true) || this.objects.get(name)?.etag !== etag) throw Error("FICTIONAL_PRIVATE_ERROR");
    const next = `"${++this.sequence}"`; this.objects.set(name, { bytes: Buffer.from(bytes), etag: next }); return next;
  }
}
export async function cloudFixture(options: { review?: boolean; issue?: string; publicationDate?: string; blob?: FictionalCloudBlob;
  target?: CloudConfiguration["expectedTarget"]; packages?: CloudManifest["packages"] } = {}) {
  const blob = options.blob ?? new FictionalCloudBlob(), data = manualFixture("JPA", 1, {
    review: options.review, issue: options.issue ?? "FICTIONAL-PILOT-ISSUE", publicationDate: options.publicationDate ?? "2099-03-11" });
  const sourceSha = sha256(data), sourceName = cloudSourceName(sourceSha);
  const sourceEtag = blob.objects.get(sourceName)?.etag ?? await blob.create(sourceName, data);
  const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes: data }, limits: buildKohoManualImportLimits(data.length) });
  const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: sourceSha });
  const config: CloudConfiguration = { approval: "REGULAR_PRODUCTION_PILOT_V1", operationId: randomUUID(), mode: "apply", storageAccount: "fictionalstorage", container: "fictional-pilot",
    expectedCodeSha: "a".repeat(40), expectedEnvironmentResourceId: "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/fictional/providers/Microsoft.App/managedEnvironments/fictional",
    expectedTarget: options.target ?? { host: "fictional.postgres.database.azure.com", port: 5432, database: "fictional", user: "koho_pilot_fictional" },
    manifest: { byteLength: 1, sha256: "0".repeat(64), etag: '"1"' } };
  const manifest: CloudManifest = { schemaVersion: 1, approval: config.approval, operationId: config.operationId, mode: config.mode,
    codeSha: config.expectedCodeSha, environmentResourceId: config.expectedEnvironmentResourceId, target: config.expectedTarget,
    round: 1, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), maxTotalBytes: 100_000_000,
    maxDatabaseBytes: 4 * 1024 ** 3, reservedGrowthBytes: 100_000_000, maxElapsedMs: 60_000, allowReviewRequired: false,
    packages: options.packages ?? [{ packageType: "JPA", byteLength: data.length, sha256: sourceSha, etag: sourceEtag,
      planSha256: cloudPlanSha256(plan), documentCount: plan.documentCount, expectedReviewRequired: plan.packageStatus === "review_required",
      expectedDisposition: "inserted", publicationDate: options.publicationDate ?? "2099-03-11", issueNumber: options.issue ?? "FICTIONAL-PILOT-ISSUE", distributionTableSha256: "b".repeat(64) }] };
  async function publish() {
    const bytes = Buffer.from(JSON.stringify(manifest)), name = cloudManifestName(config);
    const previous = blob.objects.get(name);
    const etag = previous ? await blob.replace(name, bytes, previous.etag) : await blob.create(name, bytes);
    config.manifest = { byteLength: bytes.length, sha256: sha256(bytes), etag };
  }
  await publish(); return { config, manifest, blob, data, plan, publish };
}
