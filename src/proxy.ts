import { NextResponse, type NextRequest } from "next/server";
import { OWNER_CACHE_CONTROL } from "./lib/owner-auth";
import { applicationIdentity, checkTrialRequest, trialDenied, trialPeriodPage } from "./lib/trial/http";
import { TrialError, trialWindow } from "./lib/trial/policy";
import { trialRoute } from "./lib/trial/routes";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health" && ["GET", "HEAD"].includes(request.method)) return NextResponse.next();
  const identity = applicationIdentity(request.headers, request.method);
  if (identity.denied) return identity.denied;
  if (identity.policy) {
    const route = trialRoute(request.nextUrl.pathname, request.method);
    if (route?.kind === "page" && trialWindow(identity.policy) !== "active") return trialPeriodPage(identity.policy);
    try { checkTrialRequest(identity.policy, request.nextUrl.pathname, request.method); }
    catch (error) { return trialDenied(error instanceof TrialError ? error.code : "trial_unavailable"); }
  }
  const response = NextResponse.next(); response.headers.set("Cache-Control", OWNER_CACHE_CONTROL);
  response.headers.set("X-Content-Type-Options", "nosniff"); return response;
}
// All paths including RSC, assets, API, PDF/CSV and future routes are protected.
export const config = { matcher: "/:path*" };
