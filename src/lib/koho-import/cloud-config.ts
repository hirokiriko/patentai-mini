/** Private, hash-bound operator manifest. This is a separate entrypoint from Local import. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireManual } from "./manual-cli-config";
import { updateDate } from "./update-check-config";
import type { KohoImportPlan } from "./types";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const codeSha = z.string().regex(/^[a-f0-9]{40}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = z.number().int().positive().max(2 * 1024 ** 3);
const environment = z.string().regex(/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/managedEnvironments\/[a-zA-Z0-9-]{1,60}$/);
const etag = z.string().regex(/^"[A-Za-z0-9]+"$/).max(128);
export const cloudTargetSchema = z.object({ host: z.string().regex(/^[a-z0-9-]+\.postgres\.database\.azure\.com$/),
  port: z.literal(5432), database: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/) }).strict();
const configSchema = z.object({ approval: z.literal("REGULAR_PRODUCTION_PILOT_V1"), operationId: z.uuidv4(),
  mode: z.enum(["preview", "apply"]), storageAccount: z.string().regex(/^[a-z0-9]{3,24}$/),
  container: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).refine(x => !x.includes("--")),
  managedIdentityClientId: z.uuid().optional(), expectedCodeSha: codeSha, expectedEnvironmentResourceId: environment, expectedTarget: cloudTargetSchema,
  manifest: z.object({ sha256: sha, etag, byteLength: z.number().int().positive().max(131072) }).strict(),
}).strict();
const managedConfigSchema = configSchema.extend({ approval: z.literal("STANDARD_MANAGED_WATCH_RELEASE_V1") });
const allConfigs = z.discriminatedUnion("approval", [configSchema, managedConfigSchema]);
export type CloudConfiguration = z.infer<typeof allConfigs>;
const manifestSchema = z.object({ schemaVersion: z.literal(1), approval: z.literal("REGULAR_PRODUCTION_PILOT_V1"),
  operationId: z.uuidv4(), mode: z.enum(["preview", "apply"]), codeSha,
  expiresAt: z.iso.datetime({ precision: 3 }), environmentResourceId: environment, target: cloudTargetSchema, round: z.union([z.literal(1), z.literal(2)]),
  maxTotalBytes: z.number().int().positive().max(4 * 1024 ** 3), maxDatabaseBytes: z.number().int().positive().max(1024 ** 5),
  reservedGrowthBytes: z.number().int().positive().max(1024 ** 5), maxElapsedMs: z.number().int().min(1000).max(115 * 60_000),
  allowReviewRequired: z.boolean(),
  packages: z.array(z.object({ packageType: z.enum(["JPA", "JPB"]), byteLength: bytes, sha256: sha, etag,
    planSha256: sha, documentCount: count, expectedReviewRequired: z.boolean(), expectedDisposition: z.enum(["inserted", "reused"]),
    publicationDate: updateDate, issueNumber: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), distributionTableSha256: sha }).strict()).min(1).max(4),
}).strict();
const managedManifestSchema = manifestSchema.extend({ approval: z.literal("STANDARD_MANAGED_WATCH_RELEASE_V1"), round: z.number().int().min(1).max(40),
  maxTotalBytes: z.number().int().positive().max(8 * 1024**3),
  // These are release-wide reservations, including this batch and all unknown outcomes.
  releaseReservation: z.object({ packageCount: z.number().int().min(1).max(64), compressedBytes: z.number().int().positive().max(64 * 1024**3),
    jobExecutions: z.number().int().min(1).max(24), jobMinutes: z.number().int().min(1).max(48*60), ledgerDigest: sha,
    additionalForecastYen: z.number().int().positive().max(50_000), monthlyForecastYen: z.number().int().positive().max(30_000) }).strict(),
  packages: z.array(manifestSchema.shape.packages.element.extend({ packageType: z.literal("JPA"), managedSourcesSha256: sha, managedReceiptSha256: sha })).min(1).max(4),
});
const allManifests = z.discriminatedUnion("approval", [manifestSchema, managedManifestSchema]);
export type CloudManifest = z.infer<typeof allManifests>;
export function parseCloudConfiguration(value: unknown) { return allConfigs.parse(value); }
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Independent approved digest binds every parsed field, not only the document count. */
export function cloudPlanSha256(plan: KohoImportPlan) {
  return sha256(JSON.stringify({ ...plan, documents: [...plan.documents].sort((a, b) =>
    a.normalizedEntryPath < b.normalizedEntryPath ? -1 : a.normalizedEntryPath > b.normalizedEntryPath ? 1 : 0) }));
}
export function parseCloudManifest(bytes: Uint8Array, config: CloudConfiguration, now = Date.now(), requireFresh = true) {
  requireManual(bytes.byteLength === config.manifest.byteLength && sha256(bytes) === config.manifest.sha256);
  const manifest = allManifests.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  requireManual(manifest.approval === config.approval && manifest.operationId === config.operationId && manifest.mode === config.mode && manifest.codeSha === config.expectedCodeSha &&
    manifest.environmentResourceId === config.expectedEnvironmentResourceId &&
    Object.keys(config.expectedTarget).every(key => config.expectedTarget[key as keyof typeof config.expectedTarget] === manifest.target[key as keyof typeof manifest.target]));
  const expiry = Date.parse(manifest.expiresAt);
  requireManual((!requireFresh || (expiry > now && expiry - now <= 6 * 60 * 60_000)) &&
    manifest.packages.reduce((n, p) => n + p.byteLength, 0) <= manifest.maxTotalBytes &&
    new Set(manifest.packages.map(p => p.sha256)).size === manifest.packages.length);
  if (manifest.approval === "STANDARD_MANAGED_WATCH_RELEASE_V1") requireManual(manifest.releaseReservation.packageCount >= manifest.packages.length &&
    manifest.releaseReservation.compressedBytes >= manifest.packages.reduce((n,p)=>n+p.byteLength,0) && manifest.releaseReservation.jobMinutes >= Math.ceil(manifest.maxElapsedMs/60_000));
  return manifest;
}
export const cloudManifestName = (config: CloudConfiguration) => `manifests/${config.operationId}.json`;
export const cloudSourceName = (sha: string) => `inputs/${sha}.zip`;
export const cloudReceiptPrefix = (config: CloudConfiguration) => `receipts/${config.operationId}/`;
