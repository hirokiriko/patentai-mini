import { cloudFixture } from "./koho-cloud-import-fixtures";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { projectManagedPackage } from "../src/lib/koho-import/managed-package";
import { cloudManifestName, sha256, type CloudConfiguration, type CloudManifest } from "../src/lib/koho-import/cloud-config";
export async function managedCloudImportFixture() {
  const f = await cloudFixture({ issue: "2026-148", publicationDate: "2026-08-12" });
  const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes: f.data }, limits: buildKohoManualImportLimits(f.data.length) });
  const managed = projectManagedPackage(parsed, f.plan);
  const config: CloudConfiguration = { ...f.config, approval: "STANDARD_MANAGED_WATCH_RELEASE_V1" };
  const manifest: CloudManifest = { ...f.manifest, approval: config.approval, packages: f.manifest.packages.map(p => ({ ...p, packageType: "JPA", managedSourcesSha256: managed.managedSourcesSha256, managedReceiptSha256: managed.managedReceiptSha256 })),
    releaseReservation: { packageCount: 1, compressedBytes: f.data.length, jobExecutions: 1, jobMinutes: 120, ledgerDigest: "f".repeat(64), additionalForecastYen: 30_000, monthlyForecastYen: 20_000 } };
  async function publish() {
    const bytes = Buffer.from(JSON.stringify(manifest)), name = cloudManifestName(config), old = f.blob.objects.get(name)!;
    const etag = await f.blob.replace(name, bytes, old.etag); config.manifest = { byteLength: bytes.length, sha256: sha256(bytes), etag };
  }
  await publish(); return { ...f, config, manifest, managed, publish };
}
