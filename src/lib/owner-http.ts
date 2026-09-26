import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { authorizeOwner, ownerAuthConfig, ownerDenied, OWNER_CACHE_CONTROL } from "./owner-auth";

export function withOwnerRoute<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    const request = args[0];
    if (!(request instanceof Request)) return ownerDenied("unauthenticated");
    const decision = authorizeOwner(request.headers, request.method, ownerAuthConfig(process.env));
    if (decision !== "owner") return ownerDenied(decision);
    let response: Response;
    try { response = await handler(...args); }
    catch { response = Response.json({ error: "operation_unavailable" }, { status: 503 }); }
    response.headers.set("Cache-Control", OWNER_CACHE_CONTROL);
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  };
}
/** Recheck before page data reads; layout alone does not stop parallel RSC reads. */
export async function requireOwner(): Promise<void> {
  if (authorizeOwner(await headers(), "GET", ownerAuthConfig(process.env)) !== "owner") notFound();
}
