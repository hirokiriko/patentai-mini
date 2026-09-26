import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ drafts: vi.fn(), prior: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/owner-http", () => import("./owner-http"));
vi.mock("@/repositories", () => ({ draftPatentRepo: { findByCaseId: boundary.drafts }, priorArtDocumentRepo: { findByCaseId: boundary.prior } }));
vi.mock("@/lib/blob-storage", async () => ({ ...(await import("./blob-storage")), readOriginalFile: boundary.read }));
vi.mock("@/lib/original-file-metadata", () => import("./original-file-metadata"));
vi.mock("@/lib/patent-watch/managed-api", () => import("./patent-watch/managed-api"));
import { GET } from "../app/api/cases/[caseId]/attachments/[kind]/[documentId]/route";
const owner="22222222-2222-2222-2222-222222222222",tenant="11111111-1111-1111-1111-111111111111",client="33333333-3333-3333-3333-333333333333";
const origin="https://fictional.invalid",name="cases/1/drafts/main/1700000000000-11111111-1111-4111-8111-111111111111-fictional.txt";
function request(id:string|null=owner) {
  const headers=new Headers();if(id)headers.set("x-ms-client-principal",Buffer.from(JSON.stringify({auth_typ:"aad",claims:[{typ:"oid",val:id},{typ:"tid",val:tenant},{typ:"aud",val:client},{typ:"iss",val:`https://login.microsoftonline.com/${tenant}/v2.0`}]})).toString("base64"));
  return new Request(origin,{headers});
}
const context=(caseId="1",kind="draft",documentId="7")=>({params:Promise.resolve({caseId,kind,documentId})});
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv("OWNER_AUTH_MODE","azure-easy-auth");vi.stubEnv("OWNER_APP_ORIGIN",origin);vi.stubEnv("OWNER_TENANT_ID",tenant);vi.stubEnv("OWNER_OBJECT_ID",owner);vi.stubEnv("OWNER_CLIENT_ID",client);
  boundary.drafts.mockResolvedValue([{draftId:7,caseId:1,sourceFilePath:name}]);boundary.prior.mockResolvedValue([]);boundary.read.mockResolvedValue({bytes:Buffer.from("架空原本"),contentType:"text/plain"});
});
afterEach(()=>vi.unstubAllEnvs());
it("authorizes before DB/Blob access and rejects another same-tenant subject",async()=>{
  expect((await GET(request(null),context())).status).toBe(401);expect((await GET(request("44444444-4444-4444-4444-444444444444"),context())).status).toBe(403);
  expect(boundary.drafts).not.toHaveBeenCalled();expect(boundary.read).not.toHaveBeenCalled();
});
it("checks case ownership of both DB row and original key before reading",async()=>{
  expect((await GET(request(),context("2"))).status).toBe(404);
  boundary.drafts.mockResolvedValue([{draftId:7,caseId:1,sourceFilePath:name.replace("cases/1/","cases/2/")}]);
  expect((await GET(request(),context())).status).toBe(404);expect(boundary.read).not.toHaveBeenCalled();
});
it("returns exact bytes behind a fixed no-store attachment URL with no AI",async()=>{
  const response=await GET(request(),context());expect(response.status).toBe(200);expect(await response.text()).toBe("架空原本");
  expect(response.headers.get("cache-control")).toContain("no-store");expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="original-7.txt"');expect(boundary.read).toHaveBeenCalledWith(1,"drafts",name);
});
it("does not expose storage credentials or provider errors",async()=>{
  boundary.read.mockRejectedValue(Error("FICTIONAL_PRIVATE_CREDENTIAL_SENTINEL"));const response=await GET(request(),context());
  expect(response.status).toBe(503);expect(await response.text()).not.toContain("SENTINEL");
});
