import { authorizeOwner, ownerAuthConfig, ownerDenied, OWNER_CACHE_CONTROL } from "../owner-auth";
import { assertTrialDatabase, readTrialPolicy, trialConfigured, trialWindow, TrialError, type TrialPolicy } from "./policy";
import { trialRoute, type TrialRoute } from "./routes";

export function applicationIdentity(headers: Headers, method: string): { policy: TrialPolicy | null; denied: Response | null } {
  if (!trialConfigured()) {
    if (process.env.DEPLOYMENT_KIND && process.env.DEPLOYMENT_KIND !== "production") return { policy: null, denied: trialDenied("trial_unavailable", 503) };
    const decision = authorizeOwner(headers, method, ownerAuthConfig(process.env));
    return { policy: null, denied: decision === "owner" ? null : ownerDenied(decision) };
  }
  try {
    const policy = readTrialPolicy();
    const decision = authorizeOwner(headers, method, { ...policy.auth, tenantId: policy.auth.tenantId.toLowerCase(),
      ownerId: policy.auth.ownerId.toLowerCase(), clientId: policy.auth.clientId.toLowerCase() });
    return { policy, denied: decision === "owner" ? null : ownerDenied(decision) };
  } catch { return { policy: null, denied: trialDenied("trial_unavailable", 503) }; }
}
export function trialDenied(code: string, status = 403): Response {
  return Response.json({ error: code }, { status, headers: { "Cache-Control": OWNER_CACHE_CONTROL, "X-Content-Type-Options": "nosniff" } });
}
export function checkTrialRequest(policy: TrialPolicy, path: string, method: string, now = Date.now()): TrialRoute {
  const route = trialRoute(path, method);
  if (!route) throw new TrialError("trial_function_denied");
  if (route.kind === "health" || route.kind === "asset") return route;
  if (trialWindow(policy, now) !== "active") throw new TrialError("trial_outside_period");
  assertTrialDatabase(policy, process.env.DATABASE_URL);
  if (route.managed && !policy.samples.some(s => s.caseId === route.caseId)) throw new TrialError("trial_sample_not_ready");
  return route;
}
export function trialPeriodPage(policy: TrialPolicy): Response {
  const text = trialWindow(policy) === "ended" ? "試用期間は終了しました" : "試用開始前です";
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${text}</title><main style="max-width:40rem;margin:5rem auto;padding:1.5rem;font-family:sans-serif"><h1>${text}</h1><p>この期間は案件の閲覧・比較・帳票の取得を利用できません。</p></main></html>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": OWNER_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
}
