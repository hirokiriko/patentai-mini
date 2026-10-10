import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ownerDenied, OWNER_CACHE_CONTROL } from "./owner-auth";
import { applicationIdentity, checkTrialRequest, trialDenied } from "./trial/http";
import { TrialError, trialWindow } from "./trial/policy";

export function withOwnerRoute<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    const request = args[0];
    if (!(request instanceof Request)) return ownerDenied("unauthenticated");
    const identity = applicationIdentity(request.headers, request.method);
    if (identity.denied) return identity.denied;
    if (identity.policy) {
      try {
        const url = new URL(request.url), route = checkTrialRequest(identity.policy, url.pathname, request.method);
        if (url.search) throw new TrialError("trial_function_denied");
        const context = args[1] as { params?: Promise<Record<string, string>> } | undefined;
        if (context?.params) {
          const params = await context.params;
          if (params.caseId !== undefined && String(route.caseId) !== params.caseId) throw new TrialError("trial_function_denied");
        }
        checkTrialRequest(identity.policy, url.pathname, request.method);
      } catch (error) { return trialDenied(error instanceof TrialError ? error.code : "trial_unavailable"); }
    }
    let response: Response;
    try { response = await handler(...args); }
    catch { response = Response.json({ error: "operation_unavailable" }, { status: 503 }); }
    // Already-started writes/usage settle in the handler; expired data is not returned.
    if (identity.policy && trialWindow(identity.policy) !== "active") return trialDenied("trial_outside_period");
    response.headers.set("Cache-Control", OWNER_CACHE_CONTROL);
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  };
}
/** Recheck before page data reads; layout alone does not stop parallel RSC reads. */
export async function requireOwner(path?: string): Promise<void> {
  const identity = applicationIdentity(await headers(), "GET");
  if (identity.denied) notFound();
  if (identity.policy) {
    try { if (!path) throw new TrialError(); checkTrialRequest(identity.policy, path, "GET"); }
    catch { notFound(); }
  }
}
