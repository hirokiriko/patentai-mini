import { NextResponse, type NextRequest } from "next/server";
import { authorizeOwner, ownerAuthConfig, ownerDenied, OWNER_CACHE_CONTROL } from "./lib/owner-auth";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health" && ["GET", "HEAD"].includes(request.method)) return NextResponse.next();
  const decision = authorizeOwner(request.headers, request.method, ownerAuthConfig(process.env));
  if (decision !== "owner") return ownerDenied(decision);
  const response = NextResponse.next(); response.headers.set("Cache-Control", OWNER_CACHE_CONTROL);
  response.headers.set("X-Content-Type-Options", "nosniff"); return response;
}
// All paths including RSC, assets, API, PDF/CSV and future routes are protected.
export const config = { matcher: "/:path*" };
