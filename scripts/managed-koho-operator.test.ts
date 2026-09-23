import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AnonymousCredential, BlobServiceClient, newPipeline } from "@azure/storage-blob";
import { afterEach, expect, it, vi } from "vitest";
import { managedCloudImportFixture } from "./managed-koho-cloud.test-support";
import { operateManagedKoho } from "./managed-koho-operator";
import { cloudManifestName, cloudReceiptPrefix, cloudSourceName } from "../src/lib/koho-import/cloud-config";
const temporary:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});
async function fixture(){
  const f=await managedCloudImportFixture(),path=await mkdtemp(join(tmpdir(),"managed-operator-test-"));temporary.push(path);
  const sourcePath=join(path,"fictional.zip");await writeFile(sourcePath,f.data);
  const files=new Map<string,Buffer>([[cloudSourceName(f.manifest.packages[0].sha256),f.data]]),calls:string[]=[];
  let loseAck="",expireAfter="";
  const pipeline=newPipeline(new AnonymousCredential(),{retryOptions:{maxTries:1},httpClient:{async sendRequest(request){
    const url=new URL(request.url),name=url.pathname.slice(`/${f.config.container}/`.length),headers=request.headers.clone();
    for(const key of headers.headerNames())headers.remove(key);
    headers.set("x-ms-request-id","fictional");headers.set("x-ms-version","2025-11-05");headers.set("etag",'"sealed"');calls.push(`${request.method}:${name}`);
    let status=200,data=Buffer.alloc(0),bodyAsText:string|undefined;
    if(url.searchParams.get("restype")==="container"){}
    else if(request.method==="PUT"){
      expect(request.headers.get("if-none-match")).toBe("*");
      if(files.has(name))status=412;
      else{files.set(name,Buffer.from(request.body as Uint8Array));status=201;}
      if(name===expireAfter)vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
      if(name===loseAck)throw Error("FICTIONAL_LOST_ACK");
    } else if(!files.has(name)){
      status=404;headers.set("x-ms-error-code","BlobNotFound");headers.set("content-type","application/xml");bodyAsText='<Error><Code>BlobNotFound</Code></Error>';
    } else {
      if(request.method==="GET")expect(request.headers.get("if-match")).toBe('"sealed"');
      data=Buffer.from(files.get(name)!);headers.set("content-length",String(data.length));
    }
    return{request,status,headers,bodyAsText,readableStreamBody:Readable.from(data)};
  }}});
  const container=new BlobServiceClient(`https://${f.config.storageAccount}.blob.core.windows.net`,pipeline).getContainerClient(f.config.container);
  const job={resourceId:"/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/fictional/providers/Microsoft.App/jobs/fictional-manual",name:"fictional-manual",
    image:`fictional.azurecr.io/patentai-mini@sha256:${"b".repeat(64)}`,databaseSecretRef:"fictional-import"};
  const input={schema:1,command:"stage",config:f.config,manifest:f.manifest,job,sources:[{sha256:f.manifest.packages[0].sha256,path:sourcePath}]};
  const arm=vi.fn(async(_url:string,method:"GET"|"POST",body?:unknown):Promise<{status:number;body:unknown}>=>{
    if(method==="POST")return{status:202,body};
    return{status:200,body:{id:job.resourceId,properties:{environmentId:f.config.expectedEnvironmentResourceId,
      configuration:{triggerType:"Manual",replicaRetryLimit:0,replicaTimeout:7200,manualTriggerConfig:{parallelism:1,replicaCompletionCount:1}},
      template:{containers:[{name:"existing-container",image:job.image}]}}}};
  });
  return{...f,input,container,arm,files,calls,lose:(name:string)=>{loseAck=name;},expire:(name:string)=>{expireAfter=name;}};
}
it.each(["manifest","staged"])("recovers lost %s ACK from original approved input, without writes or ARM calls",async(which)=>{
  const f=await fixture();f.lose(which==="manifest"?cloudManifestName(f.config):cloudReceiptPrefix(f.config)+"staged.json");
  await expect(operateManagedKoho(f.input,f.container,f.arm)).rejects.toThrow();
  const writes=f.calls.filter(c=>c.startsWith("PUT:"));vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
  const result=await operateManagedKoho({...f.input,command:"status"},f.container,f.arm);
  expect(result.status).toBe("staged");expect(result).toMatchObject({config:{manifest:{etag:'"sealed"'}},manifest:{packages:[{etag:'"sealed"'}]}});
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual(writes);expect(f.arm).not.toHaveBeenCalled();
  await expect(operateManagedKoho({...f.input,command:"status",manifest:{...f.manifest,round:2}},f.container,f.arm)).rejects.toThrow();
});
it.each(["get","marker"])("does not send start after expiry during %s acknowledgement",async(where)=>{
  const f=await fixture(),sealed=await operateManagedKoho(f.input,f.container,f.arm);expect(sealed.status).toBe("staged");
  if(!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  if(where==="get"){
    const original=f.arm.getMockImplementation()!;f.arm.mockImplementation(async(...args)=>{
      const r=await original(...args);vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);return r;
    });
  }else f.expire(cloudReceiptPrefix(f.config)+"start-requested.json");
  await expect(operateManagedKoho({...f.input,config:sealed.config,manifest:sealed.manifest,command:"start"},f.container,f.arm)).rejects.toThrow();
  expect(f.arm.mock.calls.filter(c=>c[1]==="GET")).toHaveLength(1);
  expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(0);
});
it("sends one fixed start, retains ambiguous reservation, and checks historical receipts after expiry",async()=>{
  const f=await fixture(),sealed=await operateManagedKoho(f.input,f.container,f.arm);
  if(!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  const input={...f.input,config:sealed.config,manifest:sealed.manifest,command:"start"};
  await expect(operateManagedKoho({...input,job:{...input.job,databaseSecretRef:"other-import"}},f.container,f.arm)).rejects.toThrow();
  expect(f.arm).not.toHaveBeenCalled();
  expect((await operateManagedKoho(input,f.container,f.arm)).status).toBe("submitting");
  await expect(operateManagedKoho(input,f.container,f.arm)).rejects.toThrow();
  expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(1);
  const body=f.arm.mock.calls.find(c=>c[1]==="POST")![2];
  expect(body).toMatchObject({containers:[{name:"existing-container",resources:{cpu:2,memory:"4Gi"},env:[{name:"KOHO_CLOUD_CONFIG_JSON"},{name:"KOHO_CLOUD_DATABASE_PASSWORD",secretRef:"fictional-import"}]}]});
  vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
  expect(await operateManagedKoho({...f.input,command:"status"},f.container,f.arm)).toMatchObject({status:"reconciliation_required",stage:"start_requested"});
  f.files.set(cloudReceiptPrefix(f.config)+"finished.json",Buffer.from(JSON.stringify({operationId:f.config.operationId,manifestSha256:sealed.config.manifest.sha256,
    codeSha:f.config.expectedCodeSha,status:"complete",cleanup:"complete",capacityConfirmed:true,databaseGrowthBytes:12})));
  expect(await operateManagedKoho({...f.input,command:"status"},f.container,f.arm)).toEqual({status:"complete",cleanup:"complete",capacityConfirmed:true,databaseGrowthBytes:12});
});
