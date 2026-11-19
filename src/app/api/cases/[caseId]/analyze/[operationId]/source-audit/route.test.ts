import { afterEach,beforeEach,expect,it,vi } from "vitest";
const seam=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/lib/prior-art-comparison/repository",()=>({getComparisonSourceAudit:seam.read}));
vi.mock("@/lib/owner-http",()=>import("../../../../../../../lib/owner-http"));
vi.mock("@/lib/prior-art-comparison/http",()=>import("../../../../../../../lib/prior-art-comparison/http"));
vi.mock("@/lib/prior-art-comparison/source",()=>import("../../../../../../../lib/prior-art-comparison/source"));
vi.mock("next/headers",()=>({headers:vi.fn()}));
vi.mock("next/navigation",()=>({notFound:vi.fn()}));
import { GET } from "./route";
const id="12345678-1234-4234-8234-123456789abc", owner="11111111-1111-1111-1111-111111111111",tenant="22222222-2222-2222-2222-222222222222";
const context=(operationId=id)=>({params:Promise.resolve({caseId:"1",operationId})});
function request(oid?:string){return new Request("https://example.invalid/api/cases/1/analyze/"+id+"/source-audit",{headers:oid?{"x-ms-client-principal":Buffer.from(JSON.stringify({auth_typ:"aad",claims:[{typ:"oid",val:oid},{typ:"tid",val:tenant}]})).toString("base64")}:undefined});}
beforeEach(()=>{vi.resetAllMocks(); for(const [key,value] of Object.entries({OWNER_AUTH_MODE:"azure-easy-auth",OWNER_APP_ORIGIN:"https://example.invalid",OWNER_OBJECT_ID:owner,OWNER_TENANT_ID:tenant,OWNER_CLIENT_ID:"33333333-3333-3333-3333-333333333333"}))vi.stubEnv(key,value);});
afterEach(()=>vi.unstubAllEnvs());
it("denies unauthenticated and other-owner reads before repository access",async()=>{
 expect((await GET(request(),context())).status).toBe(401);
 expect((await GET(request(tenant),context())).status).toBe(403);
 expect(seam.read).not.toHaveBeenCalled();
});
it("returns OWNER-only no-store attachment and no dispatch capability",async()=>{
 seam.read.mockResolvedValue({answers:[{value:{original:"原文"}}]});
 const response=await GET(request(owner),context());
 expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
 expect(response.headers.get("content-disposition")).toContain("attachment");
 expect(await response.json()).toEqual({answers:[{value:{original:"原文"}}]});
 expect(seam.read).toHaveBeenCalledExactlyOnceWith(1,id);
});
it("rejects malformed operation before reading",async()=>{
 expect((await GET(request(owner),context("bad"))).status).toBe(404);expect(seam.read).not.toHaveBeenCalled();
});

it("returns identical OWNER-only private JSON for explicit inline mode",async()=>{
 const audit={version:2,answers:[{taskId:"source",value:{fact:"原文"}}],reviewFailure:{generation:{status:"captured",value:{field:"生成"}},review:{status:"captured",value:{assertions:[]}}}};
 seam.read.mockResolvedValue(audit);const source=request(owner);const response=await GET(new Request(source.url+"?format=inline",source),context());
 expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("application/json");expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");expect(response.headers.get("content-disposition")).toBeNull();expect(await response.json()).toEqual(audit);expect(seam.read).toHaveBeenCalledExactlyOnceWith(1,id);
});
it("inline mode keeps authentication and operation validation",async()=>{
 for(const oid of [undefined,tenant]){const source=request(oid);expect((await GET(new Request(source.url+"?format=inline",source),context())).status).toBe(oid?403:401);}
 const source=request(owner);expect((await GET(new Request(source.url+"?format=inline",source),context("bad"))).status).toBe(404);expect(seam.read).not.toHaveBeenCalled();
});
it("unrecognized format retains default attachment",async()=>{seam.read.mockResolvedValue({answers:[]});const source=request(owner);const response=await GET(new Request(source.url+"?format=other",source),context());expect(response.headers.get("content-disposition")).toContain("attachment");});
