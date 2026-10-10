/** Explicit trial surface. New routes and methods remain denied until reviewed. */
export type TrialRoute = { kind: "health" | "asset" | "page" | "api"; caseId?: number; managed?: boolean };
const integer = "([1-9][0-9]{0,9})";
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const rules: ReadonlyArray<readonly [string, RegExp, boolean?]> = [
  ["GET POST", /^\/api\/cases$/],
  ["GET PATCH", new RegExp(`^/api/cases/${integer}$`)],
  ["GET POST", new RegExp(`^/api/cases/${integer}/draft$`)],
  ["POST", new RegExp(`^/api/cases/${integer}/draft/${integer}/extract$`)],
  ["GET", new RegExp(`^/api/cases/${integer}/managed-watch$`), true],
  ["POST", new RegExp(`^/api/cases/${integer}/managed-watch/runs$`), true],
  ["POST", new RegExp(`^/api/cases/${integer}/managed-watch/runs/${uuid}$`), true],
  ["GET PATCH", new RegExp(`^/api/cases/${integer}/managed-watch/findings/${integer}$`), true],
  ["POST", new RegExp(`^/api/cases/${integer}/managed-watch/(?:distribution|deliveries)$`), true],
  ["POST", new RegExp(`^/api/cases/${integer}/managed-watch/deliveries/${uuid}/reconcile$`), true],
  ["GET", new RegExp(`^/api/cases/${integer}/managed-watch/deliveries/${uuid}/(?:pdf|csv)$`), true],
  ["GET", new RegExp(`^/api/cases/${integer}/attachments/(?:draft|prior-art)/${integer}$`)],
];
export function trialRoute(path: string, method: string): TrialRoute | null {
  if (path.includes("%") || path.includes("\\") || path.includes("//")) return null;
  if (path === "/api/health" && ["GET", "HEAD"].includes(method)) return { kind: "health" };
  if (method === "GET" && (/^\/_next\/static\/[A-Za-z0-9_./-]+$/.test(path) && !path.includes("..") || path === "/favicon.ico")) return { kind: "asset" };
  // Easy Auth handles its callback/logout at the platform ingress, not an app API.
  if (method === "GET" && path === "/") return { kind: "page" };
  const page = new RegExp(`^/cases/${integer}(?:/managed-watch(?:/deliveries/${uuid})?)?$`).exec(path);
  if (method === "GET" && page && Number(page[1]) <= 2_147_483_647)
    return { kind: "page", caseId: Number(page[1]), managed: path.includes("/managed-watch") };
  for (const [methods, pattern, managed] of rules) {
    const match = pattern.exec(path);
    if (methods.split(" ").includes(method) && match && (!match[1] || Number(match[1]) <= 2_147_483_647))
      return { kind: "api", ...(match[1] ? { caseId: Number(match[1]) } : {}), ...(managed ? { managed } : {}) };
  }
  return null;
}
