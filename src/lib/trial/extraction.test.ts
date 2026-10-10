import { afterEach,describe,it,expect,vi } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { generateObject } from "ai";
import { z } from "zod";
import { runTrialExtraction } from "./extraction";
import { boundedAzureFetch,withTrialAiBudget } from "../ai-operation-budget";
import { trialAiTransport } from "./ai-transport";
import { ledgerFixture } from "./ledger.test-support";
import { signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START,TRIAL_END } from "./policy";
import { trialHash } from "./ledger";
vi.mock("./runtime",()=>({verifyTrialBuild:async()=>undefined}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();});
function setup(){
  const f=ledgerFixture();for(const[k,v]of Object.entries(signedTrialEnvironment(f.ledger.policy)))vi.stubEnv(k,v);
  vi.stubEnv("TRIAL_RUNTIME_ROLE","worker");vi.stubEnv("IDENTITY_ENDPOINT","http://127.0.0.1:4231/msi/token");vi.stubEnv("IDENTITY_HEADER","fictional");
  vi.useFakeTimers();vi.setSystemTime(new Date(TRIAL_START));
  const p=f.ledger.policy,network=vi.fn(async()=>Response.json({id:"resp_fictional",object:"response",created_at:0,model:p.ai.normalDeployment,status:"completed",
    output:[{id:"msg_fictional",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:'{"ok":true}',annotations:[]}]}],
    usage:{input_tokens:10,output_tokens:5,total_tokens:15}}));
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json({access_token:"fictional",token_type:"Bearer",resource:"https://cognitiveservices.azure.com/",client_id:p.identity.workerClientId,expires_on:String(Date.now()/1000+3600)})));
  const generate=(role:"normal"|"fast")=>{
    const model=createAzure({resourceName:p.ai.resourceName,apiVersion:p.ai.apiVersion,apiKey:"",fetch:boundedAzureFetch(role,trialAiTransport(role,"worker",network))})(role==="normal"?p.ai.normalDeployment:p.ai.miniDeployment);
    return generateObject({model,schema:z.object({ok:z.boolean()}),prompt:"fictional only",maxOutputTokens:100,maxRetries:0});
  };
  return{...f,network,generate};
}
describe("trial durable AI through the installed Azure SDK",()=>{
  it("settles one mini result after the window and refuses duplicate extraction after restart",async()=>{
    const f=setup(),persist=vi.fn(async(value:unknown)=>value);
    await runTrialExtraction(1,1,"fictional",async()=>{const r=await f.generate("fast");vi.setSystemTime(new Date(TRIAL_END));f.advance(Date.parse(TRIAL_END));return r.object;},persist,f.ledger);
    expect(f.current().operations[0]).toMatchObject({status:"complete",mini:1});expect(f.network).toHaveBeenCalledOnce();
    await expect(runTrialExtraction(1,1,"fictional",()=>f.generate("fast"),persist,f.ledger)).rejects.toThrow();
    expect(f.network).toHaveBeenCalledOnce();
  });
  it("retains a paid extraction whose DB write is unknown without a second send",async()=>{
    const f=setup();const persist=vi.fn(async()=>{throw Error("commit_lost");});
    await expect(runTrialExtraction(1,2,"fictional",()=>f.generate("fast"),persist,f.ledger)).rejects.toThrow();
    await expect(runTrialExtraction(1,2,"fictional",()=>f.generate("fast"),persist,f.ledger)).rejects.toThrow();
    expect(f.network).toHaveBeenCalledOnce();expect(f.current().operations[0]).toMatchObject({status:"unknown",mini:1});
  });
  it("journals three normal sends and rejects a fourth before authentication or HTTP",async()=>{
    const f=setup(),id=trialHash("compare");await f.ledger.reserve({id,intent:id,kind:"compare"});await f.ledger.claimDispatch(id);await f.ledger.claimWorker(id,"trial-job-one");
    await withTrialAiBudget({kind:"compare",deadlineAt:Date.parse(TRIAL_START)+15*60_000,journal:{reserve:e=>f.ledger.reserveCall(id,e).then(()=>undefined),reconcile:e=>f.ledger.reconcileCall(id,e).then(()=>undefined)}},async()=>{
      for(let n=0;n<3;n++)expect((await f.generate("normal")).object.ok).toBe(true);
      await expect(f.generate("normal")).rejects.toThrow();
    });
    expect(f.network).toHaveBeenCalledTimes(3);expect(f.current().operations[0].calls.every(c=>c.usage?.input===10)).toBe(true);
  });
});
