/** Azure Easy Auth verifies tokens before forwarding identity headers to this app.
 * This contract is valid only behind the verified ACA authentication ingress.
 * Never publish a direct container port or trust headers on another ingress. */
export type OwnerAuthConfig = Readonly<{ tenantId: string; ownerId: string; clientId: string; origin: string }>;
export type OwnerDecision = "owner" | "unauthenticated" | "forbidden" | "unavailable";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function ownerAuthConfig(env: Record<string, string | undefined>): OwnerAuthConfig | null {
  try {
    const origin = new URL(env.OWNER_APP_ORIGIN ?? "");
    if (env.OWNER_AUTH_MODE !== "azure-easy-auth" || origin.protocol !== "https:" || origin.origin !== env.OWNER_APP_ORIGIN ||
      !uuid.test(env.OWNER_TENANT_ID ?? "") || !uuid.test(env.OWNER_OBJECT_ID ?? "") || !uuid.test(env.OWNER_CLIENT_ID ?? "")) return null;
    return Object.freeze({ tenantId: env.OWNER_TENANT_ID!.toLowerCase(), ownerId: env.OWNER_OBJECT_ID!.toLowerCase(),
      clientId: env.OWNER_CLIENT_ID!.toLowerCase(), origin: origin.origin });
  } catch { return null; }
}
function claim(claims: Array<{ typ: string; val: string }>, names: string[]): string | null {
  const values = claims.filter(c => names.includes(c.typ)).map(c => c.val.toLowerCase());
  return values.length && new Set(values).size === 1 ? values[0] : null;
}
export function authorizeOwner(headers: Headers, method: string, config: OwnerAuthConfig | null): OwnerDecision {
  if (!config) return "unavailable";
  const encoded = headers.get("x-ms-client-principal");
  if (!encoded) return "unauthenticated";
  try {
    if (encoded.length > 32_768 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return "forbidden";
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return "forbidden";
    const principal = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (principal.auth_typ !== "aad" || !Array.isArray(principal.claims) || principal.claims.length > 128 ||
      principal.claims.some((c: { typ?: unknown; val?: unknown }) => !c || typeof c.typ !== "string" || typeof c.val !== "string" || c.typ.length > 300 || c.val.length > 4096)) return "forbidden";
    const oid = claim(principal.claims, ["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"]);
    const tid = claim(principal.claims, ["tid", "http://schemas.microsoft.com/identity/claims/tenantid"]);
    if (oid !== config.ownerId || tid !== config.tenantId) return "forbidden";
    // Tokens may have claims mapped by Easy Auth. If present they must agree;
    // cryptographic issuer/audience verification remains mandatory at Easy Auth.
    const audience = claim(principal.claims, ["aud"]), issuer = claim(principal.claims, ["iss"]);
    if (principal.claims.some((c: { typ: string }) => c.typ === "aud") && audience !== config.clientId) return "forbidden";
    if (principal.claims.some((c: { typ: string }) => c.typ === "iss") &&
      issuer !== `https://login.microsoftonline.com/${config.tenantId}/v2.0` && issuer !== `https://sts.windows.net/${config.tenantId}/`) return "forbidden";
    const identity = headers.get("x-ms-client-principal-id");
    if (identity && identity.toLowerCase() !== oid) return "forbidden";
    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) && headers.get("origin") !== config.origin) return "forbidden";
    if (headers.get("sec-fetch-site") === "cross-site" && !["GET", "HEAD"].includes(method.toUpperCase())) return "forbidden";
    return "owner";
  } catch { return "forbidden"; }
}
export const OWNER_CACHE_CONTROL = "private, no-store, max-age=0";
export function ownerDenied(decision: Exclude<OwnerDecision, "owner">): Response {
  return Response.json({ error: decision === "unavailable" ? "authentication_unavailable" : "authentication_required" }, {
    status: decision === "unavailable" ? 503 : decision === "unauthenticated" ? 401 : 403,
    headers: { "Cache-Control": OWNER_CACHE_CONTROL, "X-Content-Type-Options": "nosniff" },
  });
}
