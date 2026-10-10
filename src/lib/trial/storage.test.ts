import { afterEach,describe,expect,it,vi } from "vitest";
import { trialContainer,trialStorageHttp } from "./storage";
import { trialFixture,signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START,TRIAL_END } from "./policy";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
function install(){for(const[k,v]of Object.entries(signedTrialEnvironment()))vi.stubEnv(k,v);
  vi.stubEnv("TRIAL_RUNTIME_ROLE","web");vi.stubEnv("IDENTITY_ENDPOINT","http://127.0.0.1:4123/msi/token");vi.stubEnv("IDENTITY_HEADER","fictional");
  vi.useFakeTimers();vi.setSystemTime(new Date(TRIAL_START));}
function token(){return Response.json({access_token:"fictional-bearer",token_type:"Bearer",resource:"https://storage.azure.com/",
  client_id:trialFixture.identity.webClientId,expires_on:String(Date.now()/1000+3600)});}
describe("real SDK trial storage final transport",()=>{
  it("uses distinct signed purpose containers and keeps original writes private",async()=>{
    install();const network=vi.fn(async(url:unknown)=>String(url).startsWith("http://127.")?token():new Response(null,{status:201,headers:{etag:'"one"',"x-ms-request-id":"fictional","x-ms-version":"2025-11-05"}}));
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
    install();vi.setSystemTime(new Date(TRIAL_END));const network=vi.fn(async(url:unknown)=>String(url).startsWith("http://127.")?token():new Response(null,{status:201,headers:{etag:'"two"'}}));
    vi.stubGlobal("fetch",network);
    await trialContainer("budget").getBlockBlobClient("trial-v1/state.json").uploadData(Buffer.from("{}"),{conditions:{ifMatch:'"one"'}});
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("rejects purpose and account substitution below credentials",async()=>{
    install();const network=vi.fn(),guard=trialStorageHttp("originals",trialFixture,network);
    const req={url:"https://fictionaltrial.blob.core.windows.net/trial-artifacts/other",method:"PUT",headers:{get:()=>"Bearer fictional"}};
    await expect(guard.sendRequest(req as never)).rejects.toThrow();expect(network).not.toHaveBeenCalled();
  });
});
