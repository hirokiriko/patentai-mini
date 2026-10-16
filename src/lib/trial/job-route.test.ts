import { afterEach,beforeEach,expect,it,vi } from "vitest";
const fake=vi.hoisted(()=>({configured:vi.fn(),watch:vi.fn(),database:vi.fn()}));
vi.mock("@/lib/owner-http",()=>({withOwnerRoute:(handler:unknown)=>handler}));
vi.mock("@/lib/patent-watch/managed-web-watch",()=>({configuredManagedWebWatch:fake.configured,webManagedWatch:fake.watch}));
vi.mock("@/lib/patent-watch/managed-request-db",()=>({withManagedDeliveryDatabase:fake.database}));
vi.mock("@/lib/patent-watch/managed-api",()=>import("../patent-watch/managed-api"));
vi.mock("@/lib/trial/policy",()=>import("./policy"));
import { POST } from "../../app/api/cases/[caseId]/managed-watch/runs/[runId]/route";
beforeEach(()=>{vi.clearAllMocks();fake.configured.mockResolvedValue({});fake.watch.mockResolvedValue({status:"accepted"});
  fake.database.mockImplementation(async callback=>callback({},new AbortController().signal));});
afterEach(()=>vi.unstubAllEnvs());
const post=()=>POST(new Request("http://localhost/api/cases/1/managed-watch/runs/66666666-6666-4666-8666-666666666666",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"start"})}),
  {params:Promise.resolve({caseId:"1",runId:"66666666-6666-4666-8666-666666666666"})});
it("routes trial dispatch through its own validation without the production precheck",async()=>{
  vi.stubEnv("DEPLOYMENT_KIND","trial");fake.configured.mockRejectedValue(Error("production settings unavailable"));
  expect((await post()).status).toBe(200);expect(fake.configured).not.toHaveBeenCalled();expect(fake.watch).toHaveBeenCalledOnce();
});
it("preserves the production precheck and rejects before database access",async()=>{
  vi.stubEnv("DEPLOYMENT_KIND",undefined);fake.configured.mockRejectedValue(Error("unavailable"));
  expect((await post()).status).toBe(503);expect(fake.configured).toHaveBeenCalledOnce();expect(fake.database).not.toHaveBeenCalled();
});
