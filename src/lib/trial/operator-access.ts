import { z } from "zod";
import { createHash } from "node:crypto";
import { TrialError, trialPolicyDigest, type TrialPolicy } from "./policy";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(300).regex(/^[a-zA-Z0-9/_.-]+$/).refine(v => !v.includes("..") && !v.startsWith("/"));
export const operatorTicketSchema = z.object({
  schema: z.literal(1), id: z.uuidv4(), policyDigest: sha,
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  packages: z.array(sha).max(2),
  samples: z.array(z.object({ caseId: z.number().int().positive().max(2_147_483_647), sha256: sha, key }).strict()).max(5),
  artifacts: z.array(z.object({ caseId: z.number().int().positive().max(2_147_483_647), deliveryId: z.uuidv4() }).strict()).max(5),
}).strict();
export type OperatorTicket = z.infer<typeof operatorTicketSchema>;
export function operatorPolicyBinding(policy: TrialPolicy) {
  const base={...policy};delete base.localOperator;return trialPolicyDigest(base);
}
export function operatorTicketDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(operatorTicketSchema.parse(value))).digest("hex");
}
export type AccessClock = { utc(): number; monotonic(): number };
const systemClock: AccessClock = { utc: () => Date.now(), monotonic: () => performance.now() };
const ledgerKey = "trial-v1/state.json";
export function artifactKeys(caseId: number, deliveryId: string) {
  return ["snapshot.json", "pdf.pdf", "csv.csv"].map(name => `cases/${caseId}/managed-deliveries/${deliveryId}/${name}`);
}

/** A Local permission window, never an authorization source or a runtime MI limit. */
export class OperatorAccess {
  readonly ticket: OperatorTicket;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly anchorUtc: number;
  private readonly anchorMono: number;
  private highWater: number;
  private lastWall: number;
  private timer: ReturnType<typeof setTimeout>;
  constructor(value: unknown, readonly policy: TrialPolicy, private readonly clock: AccessClock = systemClock) {
    this.ticket = operatorTicketSchema.parse(value);
    const t = this.ticket, start = Date.parse(t.startsAt), end = Date.parse(t.endsAt);
    if (t.policyDigest !== operatorPolicyBinding(policy) || policy.localOperator?.ticketDigest !== operatorTicketDigest(t) || !(end > start && end - start <= 3_600_000) ||
      new Set(t.packages).size !== t.packages.length || new Set(t.samples.map(s => s.key)).size !== t.samples.length ||
      new Set(t.artifacts.map(a => a.deliveryId)).size !== t.artifacts.length ||
      [...t.samples, ...t.artifacts].some(s => !policy.samples.some(p => p.caseId === s.caseId)) ||
      t.samples.some(s => !new RegExp(`^cases/${s.caseId}/prior-art/[0-9]{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-sample\\.xml$`).test(s.key)) ||
      (policy.phase === "initial" && (Date.parse(policy.startsAt) < start || Date.parse(policy.endsAt) > end)))
      throw new TrialError("trial_operator_ticket_invalid");
    this.anchorUtc = this.highWater = this.lastWall = clock.utc(); this.anchorMono = clock.monotonic();
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(), Math.max(0, end - this.anchorUtc));
    this.timer.unref?.();
  }
  dispose() { clearTimeout(this.timer); this.controller.abort(); }
  check(requiredMs = 20_000) {
    const wall = this.clock.utc(), now = Math.max(wall, this.highWater, this.anchorUtc + Math.max(0, this.clock.monotonic() - this.anchorMono));
    const rolledBack = wall < this.lastWall;
    this.highWater = now; this.lastWall = wall;
    // Azure UtcNow uses strict DateTimeGreaterThan; the Local boundary matches it.
    if (rolledBack || this.signal.aborted || now <= Date.parse(this.ticket.startsAt) ||
      requiredMs < 0 || now + requiredMs >= Date.parse(this.ticket.endsAt)) {
      this.controller.abort(); throw new TrialError("trial_operator_access_expired");
    }
    return Date.parse(this.ticket.endsAt) - now;
  }
  sampleKey(caseId: number, sha256: string) {
    const matches = this.ticket.samples.filter(s => s.caseId === caseId && s.sha256 === sha256);
    if (matches.length !== 1) throw new TrialError("trial_operator_input_unbound");
    return matches[0].key;
  }
  keys(purpose: "originals" | "artifacts" | "budget") {
    return purpose === "budget" ? [ledgerKey] : purpose === "artifacts" ? this.ticket.artifacts.flatMap(a => artifactKeys(a.caseId, a.deliveryId)) :
      [...this.ticket.packages.map(s => `packages/${s}.zip`), ...this.ticket.samples.map(s => s.key)];
  }
  storage(purpose: "originals" | "artifacts" | "budget", url: string, method: string) {
    this.check();
    const u = new URL(url), container = `/${this.policy.storage[purpose]}`;
    if (u.origin !== `https://${this.policy.storage.account}.blob.core.windows.net` || u.username || u.password || u.hash ||
      !["GET", "HEAD", "PUT"].includes(method) || (purpose === "artifacts" && method === "PUT")) throw new TrialError("trial_operator_target_denied");
    const params = [...u.searchParams];
    if ([container, container + "/"].includes(u.pathname)) {
      if (!["GET", "HEAD"].includes(method) || params.length !== 1 || params[0][0] !== "restype" || params[0][1] !== "container")
        throw new TrialError("trial_operator_target_denied");
    } else if (!this.keys(purpose).some(k => u.pathname === `${container}/${k}`) ||
      params.some(([k, v]) => k !== "timeout" || !/^(?:[1-9]|1[0-9]|20)$/.test(v)) || params.length > 1)
      throw new TrialError("trial_operator_target_denied");
  }
  arm(url: string, method: string) {
    this.check(30_000);
    const u = new URL(url), base = this.policy.jobResourceId;
    if (method !== "GET" || u.origin !== "https://management.azure.com" || u.username || u.password || u.hash ||
      !([base, base + "/executions"].includes(u.pathname) || (u.pathname.startsWith(base + "/executions/") && /^[a-z0-9-]{1,100}$/.test(u.pathname.slice(base.length + 12)))) ||
      u.search !== "?api-version=2025-07-01") throw new TrialError("trial_operator_target_denied");
  }
}

/** Install before Drizzle: nested statements and its automatic COMMIT use this boundary. */
export function guardOperatorDatabase<T extends { query: (...args: never[]) => unknown; end: () => unknown }>(client: T, access: OperatorAccess) {
  const query = client.query;
  Object.defineProperty(client, "query", { value: function (...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
    // ROLLBACK is cleanup, never a new business operation or reservation release.
    if (text?.trim().toUpperCase() !== "ROLLBACK") access.check(35_000);
    return Reflect.apply(query, client, args);
  }});
  const close = () => { void Promise.resolve(client.end()).catch(() => undefined); };
  access.signal.addEventListener("abort", close, { once: true });
  return () => access.signal.removeEventListener("abort", close);
}

/** Exact-path ABAC plan only. Server parsing/effectiveness must be measured before use. */
export function operatorBlobCondition(access: OperatorAccess, purpose: "originals" | "artifacts" | "budget") {
  const paths = access.keys(purpose);
  if (!paths.length) throw new TrialError("trial_operator_input_unbound");
  const root = "Microsoft.Storage/storageAccounts/blobServices/containers", read = `${root}/blobs/read`, write = `${root}/blobs/write`;
  const scope = `@Resource[${root}:name] StringEquals '${access.policy.storage[purpose]}' AND @Resource[${root}/blobs:path] ForAnyOfAnyValues:StringEquals {${paths.map(p => `'${p}'`).join(", ")}} AND @Environment[UtcNow] DateTimeGreaterThan '${access.ticket.startsAt}' AND @Environment[UtcNow] DateTimeLessThan '${access.ticket.endsAt}'`;
  // No isCurrentVersion attribute on write: it is not supported for every write suboperation.
  return `((!(ActionMatches{'${read}'} OR ActionMatches{'${write}'})) OR (${scope})) AND (!(ActionMatches{'${read}'} AND SubOperationMatches{'Blob.List'})) AND ((!ActionMatches{'${read}'}) OR (@Resource[${root}/blobs:isCurrentVersion] BoolEquals true))${purpose === "artifacts" ? ` AND (!(ActionMatches{'${write}'}))` : ""}`;
}
