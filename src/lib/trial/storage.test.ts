import { afterEach,describe,expect,it,vi } from "vitest";
import { trialContainer,trialStorageHttp } from "./storage";
import { trialFixture,signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START,TRIAL_END } from "./policy";
import * as networkBudget from "./network-budget";
import { networkBudgetFixture } from "./network-budget.test-support";
import { ManagedPrivateStorage,type ManagedArtifactManifest } from "../patent-watch/managed-storage";
import { createHash } from "node:crypto";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
function install(){for(const[k,v]of Object.entries(signedTrialEnvironment()))vi.stubEnv(k,v);
  vi.stubEnv("TRIAL_RUNTIME_ROLE","web");vi.stubEnv("IDENTITY_ENDPOINT","http://127.0.0.1:4123/msi/token");vi.stubEnv("IDENTITY_HEADER","fictional");
  vi.useFakeTimers();vi.setSystemTime(new Date(TRIAL_START));
  const f=networkBudgetFixture(trialFixture);vi.spyOn(networkBudget,"configuredTrialNetworkBudget").mockReturnValue(f.budget);return f;}
function token(){return Response.json({access_token:"fictional-bearer",token_type:"Bearer",resource:"https://storage.azure.com/",
  client_id:trialFixture.identity.webClientId,expires_on:String(Date.now()/1000+3600)});}
describe("real SDK trial storage final transport",()=>{
  it("uses distinct signed purpose containers and keeps original writes private",async()=>{
    install();const network=vi.fn(async(url:unknown)=>String(url).startsWith("http://127.")?token():new Response(null,{status:201,headers:{etag:'"one"',"content-length":"0","x-ms-request-id":"fictional","x-ms-version":"2025-11-05"}}));
    vi.stubGlobal("fetch",network);const originals=trialContainer("originals");
    await originals.getBlockBlobClient("cases/1/drafts/fictional.txt").uploadData(Buffer.from("fictional"),{conditions:{ifNoneMatch:"*"}});
    expect(network).toHaveBeenCalledTimes(2);
    expect(String(network.mock.calls[1][0])).toContain("/trial-originals/");
    expect(trialContainer("artifacts").url).not.toBe(originals.url);expect(trialContainer("budget").url).not.toBe(originals.url);
  });
  it("refuses a new PUT when token acquisition crosses the exact end",async()=>{
    install();const network=vi.fn(async(url:unknown)=>{
      if(!String(url).startsWith("http://127."))throw Error("must_not_send");
      vi.setSystemTime(new Date(TRIAL_END));return token();
    });vi.stubGlobal("fetch",network);
    await expect(trialContainer("originals").getBlockBlobClient("cases/1/drafts/fictional.txt").uploadData(Buffer.from("fictional"))).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("allows durable usage settlement after expiry without allowing original writes",async()=>{
    install();vi.setSystemTime(new Date(TRIAL_END));const network=vi.fn(async(url:unknown)=>String(url).startsWith("http://127.")?token():new Response(null,{status:201,headers:{etag:'"two"',"content-length":"0"}}));
    vi.stubGlobal("fetch",network);
    await trialContainer("budget").getBlockBlobClient("trial-v1/state.json").uploadData(Buffer.from("{}"),{conditions:{ifMatch:'"one"'}});
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("rejects purpose and account substitution below credentials",async()=>{
    install();const network=vi.fn(),guard=trialStorageHttp("originals",trialFixture,network);
    const req={url:"https://fictionaltrial.blob.core.windows.net/trial-artifacts/other",method:"PUT",headers:{get:()=>"Bearer fictional"}};
    await expect(guard.sendRequest(req as never)).rejects.toThrow();expect(network).not.toHaveBeenCalled();
  });
  it("charges each SDK block GET against the same durable last slots",async()=>{
    const f=install();f.state.blob.requests=networkBudget.TRIAL_STORAGE_REQUEST_LIMIT-2;
    const send=vi.fn(async(url:unknown,init?:RequestInit)=>{
      if(String(url).startsWith("http://127."))return token();
      const h=new Headers(init?.headers),range=h.get("x-ms-range")??h.get("range")??"";
      const match=/bytes=(\d+)-(\d+)/.exec(range)!;const n=Number(match[2])-Number(match[1])+1;
      return new Response(new Uint8Array(n),{status:206,headers:{"content-length":String(n),etag:'"same"',"content-range":`bytes ${match[1]}-${match[2]}/8388608`}});
    });vi.stubGlobal("fetch",send);
    const blob=trialContainer("originals").getBlobClient("fictional.bin");
    await blob.downloadToBuffer(0,8*1024**2,{concurrency:1,maxRetryRequestsPerBlock:0});
    expect(f.state.blob.requests).toBe(networkBudget.TRIAL_STORAGE_REQUEST_LIMIT);
    await expect(blob.downloadToBuffer(0,1,{maxRetryRequestsPerBlock:0})).rejects.toThrow();
    expect(send.mock.calls.filter(c=>!String(c[0]).startsWith("http://127."))).toHaveLength(2);
  });
  it("does not send after an unknown reservation commit and never resets on another container",async()=>{
    const f=install();f.lose();const send=vi.fn(async()=>token());vi.stubGlobal("fetch",send);
    await expect(trialContainer("budget").getProperties()).rejects.toThrow();
    expect(f.state.blob.requests).toBe(1);expect(send).toHaveBeenCalledOnce();
  });
  it("rereads an eight MiB trial artifact through serial guarded reservations",async()=>{
    const f=install(),bytes=Buffer.alloc(8*1024**2),hash=createHash("sha256").update(bytes).digest("hex");
    let busy=false;
    vi.mocked(networkBudget.configuredTrialNetworkBudget).mockReturnValue({reserve:async request=>{
      if(busy)throw Error("fixture_guarded_client_busy");busy=true;
      try{return await f.budget.reserve(request);}finally{busy=false;}
    }});
    const send=vi.fn(async(url:unknown,init?:RequestInit)=>{
      if(String(url).startsWith("http://127."))return token();
      if(String(url).includes("restype=container"))return new Response(null,{headers:{"content-length":"0"}});
      if(init?.method==="HEAD")return new Response(null,{headers:{"content-length":String(bytes.length),etag:'"same"'}});
      const range=new Headers(init?.headers).get("x-ms-range")??"",match=/bytes=(\d+)-(\d+)/.exec(range)!;
      const part=bytes.subarray(Number(match[1]),Number(match[2])+1);
      return new Response(part,{status:206,headers:{"content-length":String(part.length),etag:'"same"',"content-range":`bytes ${match[1]}-${match[2]}/${bytes.length}`}});
    });vi.stubGlobal("fetch",send);
    const manifest:ManagedArtifactManifest={schema:1,caseId:1,deliveryId:"66666666-6666-4666-8666-666666666666",
      artifacts:(["pdf","snapshot","csv"] as const).map(kind=>({kind,sha256:hash,bytes:bytes.length}))};
    const result=await new ManagedPrivateStorage(trialContainer("artifacts")).read(manifest,"pdf");
    expect(result.equals(bytes)).toBe(true);expect(f.state.blob.requests).toBe(4);
    expect(f.state.receipts.every(r=>r.observed!==null)).toBe(true);
  });
});
