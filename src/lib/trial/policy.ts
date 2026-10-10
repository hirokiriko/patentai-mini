import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

export const TRIAL_APPROVAL = "LIGHTWEIGHT_GROUP_TRIAL_V3";
export const TRIAL_START = "2026-10-17T00:00:00Z";
export const TRIAL_END = "2026-10-31T00:00:00Z";
export const TRIAL_RETENTION_REVIEW = "2027-01-29T00:00:00Z";
const name = z.string().regex(/^[a-z][a-z0-9_-]{1,62}$/);
const container = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).refine(v => !v.includes("--"));
const resource = z.string().regex(/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/(?:jobs|managedEnvironments)\/[a-zA-Z0-9-]{1,60}$/);
const httpsOrigin = z.string().refine(v => { try { const u = new URL(v); return u.protocol === "https:" && u.origin === v; } catch { return false; } });
const yen = z.number().int().nonnegative().max(1_000_000);
const rates = z.object({ inputYenPerMillion: yen.refine(v => v > 0), outputYenPerMillion: yen.refine(v => v > 0) }).strict();
export const trialCostProfileSchema = z.object({
  checkedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  normal: rates, mini: rates,
  // Reviewed tax-inclusive upper forecasts, including shared/unknown obligations.
  initialOtherYen: yen, retainedOtherYen: yen, monthOtherYen: yen,
  sharedRemainingYen: yen, jobYenPerHour: yen.refine(v => v > 0),
  databaseBaselineBytes: z.number().int().nonnegative().safe(),
}).strict().refine(p => Date.parse(p.validUntil) > Date.parse(p.checkedAt) &&
  Date.parse(p.validUntil) - Date.parse(p.checkedAt) <= 24 * 60 * 60_000);

/** Signed operator configuration. Never accepted from HTTP input or a group header.
 * The fixed dates and limits cannot be enlarged by a profile revision or restart. */
export const trialPolicySchema = z.object({
  schema: z.literal(1), approval: z.literal(TRIAL_APPROVAL),
  phase: z.enum(["initial", "trial"]), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  retentionReviewAt: z.literal(TRIAL_RETENTION_REVIEW), codeSha: z.string().regex(/^[a-f0-9]{40}$/),
  auth: z.object({ tenantId: z.uuid(), ownerId: z.uuid(), clientId: z.uuid(), origin: httpsOrigin }).strict(),
  database: z.object({ host: z.string().regex(/^[a-z0-9-]+\.postgres\.database\.azure\.com$/),
    port: z.literal(5432), database: name, webUser: name, workerUser: name, migratorUser:name.optional(), ownerRole:name.optional() }).strict(),
  storage: z.object({ account: z.string().regex(/^[a-z0-9]{3,24}$/), originals: container, artifacts: container, budget: container }).strict(),
  identity: z.object({ webClientId: z.uuid(), workerClientId: z.uuid() }).strict(),
  ai: z.object({ resourceName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/),
    normalDeployment: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), miniDeployment: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    apiVersion: z.string().regex(/^(?:v1|\d{4}-\d{2}-\d{2}(?:-preview)?)$/) }).strict(),
  jobResourceId: resource.refine(v => v.includes("/jobs/")),
  environmentResourceId: resource.refine(v => v.includes("/managedEnvironments/")),
  image: z.string().regex(/^[a-z0-9.-]+\.azurecr\.io\/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$/).optional(),
  cost: trialCostProfileSchema.optional(),
  samples: z.array(z.object({ caseId: z.number().int().positive().max(2_147_483_647),
    from: z.iso.date(), through: z.iso.date() }).strict().refine(v => v.from <= v.through)).max(5),
}).strict().superRefine((p, ctx) => {
  const start = Date.parse(p.startsAt), end = Date.parse(p.endsAt);
  if (start >= end || (p.phase === "trial" && (p.startsAt !== TRIAL_START || p.endsAt !== TRIAL_END)) ||
    (p.phase === "initial" && (end - start > 30 * 60_000 || end > Date.parse(TRIAL_END)))) ctx.addIssue({ code: "custom", message: "invalid_window" });
  if (p.database.webUser === p.database.workerUser || p.identity.webClientId.toLowerCase() === p.identity.workerClientId.toLowerCase() ||
    new Set([p.storage.originals, p.storage.artifacts, p.storage.budget]).size !== 3 || new Set(p.samples.map(s => s.caseId)).size !== p.samples.length)
    ctx.addIssue({ code: "custom", message: "invalid_separation" });
  const roles=[p.database.webUser,p.database.workerUser,p.database.migratorUser,p.database.ownerRole].filter(Boolean);
  if(new Set(roles).size!==roles.length)ctx.addIssue({code:"custom",message:"invalid_separation"});
});
export type TrialPolicy = z.infer<typeof trialPolicySchema>;
export class TrialError extends Error { constructor(public readonly code = "trial_unavailable") { super(code); this.name = "TrialError"; } }
export type TrialEnvironment = Record<string, string | undefined>;
export function trialConfigured(env: TrialEnvironment = process.env): boolean {
  return env.DEPLOYMENT_KIND === "trial" || Object.keys(env).some(k => k.startsWith("TRIAL_") && env[k] !== undefined);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function trialPolicyBytes(policy: TrialPolicy): Buffer { return Buffer.from(canonical(trialPolicySchema.parse(policy))); }
export function trialPolicyDigest(policy: TrialPolicy): string { return createHash("sha256").update(trialPolicyBytes(policy)).digest("hex"); }
export function readTrialPolicy(env: TrialEnvironment = process.env): TrialPolicy {
  try {
    if (env.DEPLOYMENT_KIND !== "trial" || !env.TRIAL_POLICY_JSON || Buffer.byteLength(env.TRIAL_POLICY_JSON) > 32_768 ||
      !env.TRIAL_POLICY_SIGNATURE || !/^[A-Za-z0-9+/]{86}==$/.test(env.TRIAL_POLICY_SIGNATURE) || !env.TRIAL_POLICY_PUBLIC_KEY)
      throw new TrialError();
    const p = trialPolicySchema.parse(JSON.parse(env.TRIAL_POLICY_JSON));
    const key = createPublicKey(env.TRIAL_POLICY_PUBLIC_KEY);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, trialPolicyBytes(p), key, Buffer.from(env.TRIAL_POLICY_SIGNATURE, "base64"))) throw new TrialError();
    // Trial installations do not carry the production identity or account-wide keys.
    if (Object.keys(env).some(k => k.startsWith("OWNER_") && Boolean(env[k])) || env.AZURE_API_KEY || env.AZURE_STORAGE_CONNECTION_STRING ||
      env.AZURE_OPENAI_BASE_URL || env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || env.AZURE_DOCUMENT_INTELLIGENCE_KEY) throw new TrialError();
    return p;
  } catch { throw new TrialError(); }
}
export function trialWindow(policy: TrialPolicy, now = Date.now()): "before" | "active" | "ended" {
  if (!Number.isFinite(now)) throw new TrialError();
  return now < Date.parse(policy.startsAt) ? "before" : now >= Date.parse(policy.endsAt) ? "ended" : "active";
}
export function requireTrialActive(policy: TrialPolicy, now = Date.now()): void {
  if (trialWindow(policy, now) !== "active") throw new TrialError("trial_outside_period");
}
export function assertTrialDatabase(policy: TrialPolicy, connectionString: string | undefined, role: "web" | "worker" = "web"): void {
  try {
    const u = new URL(connectionString ?? ""), d = policy.database;
    if (u.protocol !== "postgresql:" || u.hostname.toLowerCase() !== d.host || Number(u.port || "5432") !== d.port ||
      decodeURIComponent(u.pathname.slice(1)) !== d.database || decodeURIComponent(u.username) !== (role === "web" ? d.webUser : d.workerUser) ||
      !u.password || u.hash || u.searchParams.getAll("sslmode").length > 1 || [...u.searchParams.keys()].some(k => k !== "sslmode") ||
      (u.searchParams.has("sslmode") && !["require", "verify-full"].includes(u.searchParams.get("sslmode")!))) throw new TrialError();
  } catch { throw new TrialError(); }
}
