import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ManagedWatchError } from "./managed-types";
const b=vi.hoisted(()=>({setting:vi.fn(),prepare:vi.fn(),finding:vi.fn(),review:vi.fn(),distribution:vi.fn(),delivery:vi.fn(),get:vi.fn(),store:vi.fn(),reconcile:vi.fn(),read:vi.fn(),database:vi.fn()}));
vi.mock("@/lib/owner-http",()=>import("../owner-http"));
vi.mock("@/lib/patent-watch/managed-api",()=>import("./managed-api"));
vi.mock("@/lib/patent-watch/managed-types",()=>import("./managed-types"));
vi.mock("@/lib/patent-watch/managed-request-db",()=>import("./managed-request-db"));
vi.mock("@/lib/patent-watch/managed-storage",()=>import("./managed-storage"));
vi.mock("@/repositories/managed-watch",()=>import("../../repositories/managed-watch"));
vi.mock("@/repositories/managed-delivery",()=>import("../../repositories/managed-delivery"));
vi.mock("../../repositories/managed-watch",()=>({ManagedWatchRepository:class{setting=b.setting;prepare=b.prepare;findingReview=b.finding;reviewFinding=b.review;}}));
vi.mock("../../repositories/managed-delivery",()=>({ManagedDeliveryRepository:class{acquireDistribution=b.distribution;prepare=b.delivery;get=b.get;}}));
vi.mock("./managed-request-db",()=>({withManagedDeliveryDatabase:b.database}));
vi.mock("./managed-storage",async()=>({...await vi.importActual<typeof import("./managed-storage")>("./managed-storage"),
  ManagedPrivateStorage:class{static configured(){return {read:b.read};}},createManagedDelivery:b.store,reconcileManagedDelivery:b.reconcile}));
import { POST as prepare } from "../../app/api/cases/[caseId]/managed-watch/runs/route";
import { POST as distribution } from "../../app/api/cases/[caseId]/managed-watch/distribution/route";
import { POST as delivery } from "../../app/api/cases/[caseId]/managed-watch/deliveries/route";
import { POST as reconcile } from "../../app/api/cases/[caseId]/managed-watch/deliveries/[deliveryId]/reconcile/route";
import { GET as finding,PATCH as review } from "../../app/api/cases/[caseId]/managed-watch/findings/[findingId]/route";
import { GET as download } from "../../app/api/cases/[caseId]/managed-watch/deliveries/[deliveryId]/[format]/route";
import { managedDeliveryFixture } from "./managed-delivery.test-support";
const owner="22222222-2222-2222-2222-222222222222",tenant="11111111-1111-1111-1111-111111111111",client="33333333-3333-3333-3333-333333333333",origin="https://fictional.invalid";
const deliveryId="12345678-1234-4234-8234-123456789012",period={from:"2026-07-26",to:"2026-08-25"};
const ctx=(caseId="7",id=deliveryId)=>({params:Promise.resolve({caseId,deliveryId:id,findingId:"9",format:"pdf"})});
function request(method:string,body:unknown,identity:string|null=owner,requestOrigin=origin,site="same-origin"){
  const headers=new Headers({"Content-Type":"application/json",Origin:requestOrigin,"Sec-Fetch-Site":site});
  if(identity)headers.set("x-ms-client-principal",Buffer.from(JSON.stringify({auth_typ:"aad",claims:[{typ:"oid",val:identity},{typ:"tid",val:tenant},{typ:"aud",val:client},{typ:"iss",val:`https://login.microsoftonline.com/${tenant}/v2.0`}]})).toString("base64"));
  return new Request(origin,{method,headers,...(method==="GET"?{}:{body:JSON.stringify(body)})});
}
const deliveryInput={deliveryId,period,distributionTableSha256:"a".repeat(64),reason:"initial",deliveredOn:null};
const routes=[{name:"prepare",route:prepare,method:"POST",body:period},{name:"distribution",route:distribution,method:"POST",body:{}},
  {name:"delivery",route:delivery,method:"POST",body:deliveryInput},{name:"reconcile",route:reconcile,method:"POST",body:{abandonPartial:false}},
  {name:"finding",route:finding,method:"GET",body:{}},{name:"review",route:review,method:"PATCH",body:{reviewed:true,expectedVersion:0}},
  {name:"download",route:download,method:"GET",body:{}}];
beforeEach(()=>{
  vi.resetAllMocks();for(const [key,value]of Object.entries({OWNER_AUTH_MODE:"azure-easy-auth",OWNER_APP_ORIGIN:origin,OWNER_TENANT_ID:tenant,OWNER_OBJECT_ID:owner,OWNER_CLIENT_ID:client}))vi.stubEnv(key,value);
  b.database.mockImplementation(async(operation)=>operation({},AbortSignal.timeout(90_000)));
  b.setting.mockResolvedValue({caseId:7});b.prepare.mockResolvedValue({runId:deliveryId});b.finding.mockResolvedValue({reviewStatus:"unreviewed",reviewVersion:0});
  b.delivery.mockResolvedValue(managedDeliveryFixture());b.reconcile.mockResolvedValue("stored");b.distribution.mockResolvedValue({sha256:"a".repeat(64)});
});
afterEach(()=>vi.unstubAllEnvs());
it.each(routes)("$name authorizes before database/storage/network access",async({route,method,body})=>{
  expect((await route(request(method,body,null),ctx())).status).toBe(401);
  expect((await route(request(method,body,"44444444-4444-4444-4444-444444444444"),ctx())).status).toBe(403);
  if(method!=="GET"){
    expect((await route(request(method,body,owner,"https://other.invalid"),ctx())).status).toBe(403);
    expect((await route(request(method,body,owner,origin,"cross-site"),ctx())).status).toBe(403);
  }
  for(const call of Object.values(b))expect(call).not.toHaveBeenCalled();
});
it("rejects malformed request fields and dates before opening a DB connection",async()=>{
  for(const body of [{from:"2026-02-30",to:"2026-03-25"},{...period,extra:true},{from:"2026-07-26",to:"2026-08-24"}])expect((await prepare(request("POST",body),ctx())).status).toBe(400);
  expect((await review(request("PATCH",{reviewed:true}),ctx())).status).toBe(400);
  expect((await delivery(request("POST",{...deliveryInput,deliveryId:"invalid"}),ctx())).status).toBe(400);
  expect((await delivery(request("POST",{...deliveryInput,deliveredOn:"2026-02-30"}),ctx())).status).toBe(400);
  expect((await reconcile(request("POST",{abandonPartial:false}),ctx("7","invalid"))).status).toBe(400);
  expect((await finding(request("GET",{}),ctx("0"))).status).toBe(400);expect(b.database).not.toHaveBeenCalled();
});
it("returns a prepared run without treating it as an accepted cloud execution",async()=>{
  const response=await prepare(request("POST",period),ctx());expect(response.status).toBe(201);expect(await response.json()).toMatchObject({status:"prepared",runId:deliveryId});
  expect(b.prepare).toHaveBeenCalledExactlyOnceWith(7,period);expect(b.store).not.toHaveBeenCalled();
});
it("does not fetch an official distribution for a missing setting",async()=>{
  b.setting.mockResolvedValue(null);expect((await distribution(request("POST",{}),ctx())).status).toBe(404);expect(b.distribution).not.toHaveBeenCalled();
});
it("passes case IDs and CAS versions unchanged and preserves not-found/conflict outcomes",async()=>{
  b.finding.mockRejectedValue(new ManagedWatchError("not_found"));expect((await finding(request("GET",{}),ctx("8"))).status).toBe(404);expect(b.finding).toHaveBeenCalledExactlyOnceWith(8,9);
  b.review.mockRejectedValue(new ManagedWatchError("conflict"));expect((await review(request("PATCH",{reviewed:true,expectedVersion:3}),ctx())).status).toBe(409);
  expect(b.review).toHaveBeenCalledExactlyOnceWith(7,9,true,3);expect(b.database).toHaveBeenLastCalledWith(expect.any(Function),20_000);
  b.get.mockRejectedValue(new ManagedWatchError("not_found"));expect((await download(request("GET",{}),ctx("8"))).status).toBe(404);expect(b.read).not.toHaveBeenCalled();
});
it("keeps duplicate deliveries and uncertain writes distinct, with no automatic retry or secret exposure",async()=>{
  b.store.mockRejectedValueOnce(new ManagedWatchError("conflict"));expect((await delivery(request("POST",deliveryInput),ctx())).status).toBe(409);expect(b.delivery).not.toHaveBeenCalled();
  b.store.mockRejectedValueOnce(new ManagedWatchError("outcome_unknown"));
  const unknown=await delivery(request("POST",deliveryInput),ctx());expect(unknown.status).toBe(503);expect(await unknown.json()).toEqual({error:"outcome_unknown"});expect(b.store).toHaveBeenCalledTimes(2);
  b.reconcile.mockRejectedValueOnce(Error("FICTIONAL_PRIVATE_SENTINEL"));const response=await reconcile(request("POST",{abandonPartial:false}),ctx());
  expect(response.status).toBe(503);expect(await response.text()).not.toContain("SENTINEL");expect(response.headers.get("cache-control")).toContain("no-store");expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  b.finding.mockRejectedValue(z.object({saved:z.string()}).safeParse({}).error);expect((await finding(request("GET",{}),ctx())).status).toBe(503);
});
