import { afterEach,describe,expect,it,vi } from "vitest";
import { startTrialWatch,executeTrialWatch,trialJobTemplate,trialJobRequestSchema,type TrialArm } from "./job";
import { TrialLedger,trialHash } from "./ledger";
import { pricedTrial,ledgerFixture } from "./ledger.test-support";
import { signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START,TRIAL_END,trialPolicyDigest } from "./policy";
import type { ManagedRun } from "../patent-watch/managed-types";
import type { ManagedWatchRepository } from "../../repositories/managed-watch";
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function fixture(){
  const p=pricedTrial(),f=ledgerFixture(p);vi.useFakeTimers();vi.setSystemTime(new Date(TRIAL_START));
  const env=signedTrialEnvironment(p);for(const[k,v]of Object.entries(env))vi.stubEnv(k,v);
  const request=trialJobRequestSchema.parse({schema:1,kind:"trial-watch",caseId:1,runId:"66666666-6666-4666-8666-666666666666",snapshotDigest:"b".repeat(64),policyDigest:trialPolicyDigest(p)});
  const run={...request,status:"prepared",executionId:null,snapshot:{candidates:[]},plan:null} as unknown as ManagedRun;
  const repo={run:vi.fn(async()=>run),claimTrial:vi.fn(async()=>{run.status="running";run.executionId="trial-job-one";return run;}),
    finalize:vi.fn(async()=>{run.status="completed";}),fail:vi.fn(async()=>{run.status="failed";}),hasUnknownDispatch:vi.fn(async()=>false),
    failUnstartedTrial:vi.fn(async()=>{run.status="failed";})};
  const template={containers:[{name:"worker",image:p.image,command:["node",".koho-ops/managed/scripts/trial-watch-worker.js"],args:null,
    resources:{cpu:2,memory:"4Gi"},env:[...Object.entries({...env,TRIAL_RUNTIME_ROLE:"worker",AI_PROVIDER:"azure"}).filter(([k])=>k!=="DATABASE_URL").map(([name,value])=>({name,value,secretRef:null})),
      {name:"DATABASE_URL",value:null,secretRef:"trial-worker-database"}]}],initContainers:null};
  const job={id:p.jobResourceId,properties:{environmentId:p.environmentResourceId,configuration:{triggerType:"Manual",replicaTimeout:1800,replicaRetryLimit:0,manualTriggerConfig:{parallelism:1,replicaCompletionCount:1}},template}};
  const observed={name:"trial-job-one",id:p.jobResourceId+"/executions/trial-job-one",properties:{status:"Succeeded",startTime:TRIAL_START,endTime:"2026-10-17T00:01:00Z",
    template:{containers:[{...template.containers[0],env:[...template.containers[0].env,{name:"TRIAL_EXECUTION_JSON",value:JSON.stringify(request),secretRef:null}]}]}}};
  const arm=vi.fn<TrialArm>(async(suffix,method)=>suffix===""?{status:200,body:job}:method==="POST"?{status:202,body:{name:observed.name,id:observed.id}}:{status:200,body:observed});
  return{...f,p,request,run,repo,repository:repo as unknown as ManagedWatchRepository,job,observed,arm};
}
describe("trial manual Job lifecycle",()=>{
  it("accepts ARM optional null fields and rejects altered resources, identity or image",()=>{
    const f=fixture();expect(trialJobTemplate(f.job,f.p,f.request).containers).toHaveLength(1);
    for(const alter of [()=>{f.job.properties.template.containers[0].resources.cpu=4;},()=>{f.job.properties.template.containers[0].image="other";}]){
      alter();expect(()=>trialJobTemplate(f.job,f.p,f.request)).toThrow();
    }
  });
  it("does not retry an unknown start after reload and retains its complete allowance",async()=>{
    const f=fixture();f.arm.mockImplementationOnce(async()=>({status:200,body:f.job})).mockImplementationOnce(async()=>{throw Error("lost_ack");});
    expect((await startTrialWatch(f.repository,1,f.request.runId,"start",f.ledger,f.arm)).status).toBe("outcome_unknown");
    await startTrialWatch(f.repository,1,f.request.runId,"start",f.ledger,f.arm);
    expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(1);expect(f.current().operations[0]).toMatchObject({status:"unknown",seconds:1800,jobs:1,terminal:false});
  });
  it("holds concurrency after persistence until a read-only terminal reconciliation, even after image/phase expiry",async()=>{
    const f=fixture();await startTrialWatch(f.repository,1,f.request.runId,"start",f.ledger,f.arm);
    await executeTrialWatch(f.repository,f.request,"trial-job-one",f.ledger);
    expect(f.repo.finalize).toHaveBeenCalledOnce();expect(f.current().operations[0]).toMatchObject({status:"complete",normal:0,terminal:false});
    const next={...f.p,image:`fictional.azurecr.io/new@sha256:${"c".repeat(64)}`};vi.setSystemTime(new Date(TRIAL_END));
    const restarted=new TrialLedger(next,f.io,()=>Date.parse(TRIAL_END));
    const settled=await startTrialWatch(f.repository,1,f.request.runId,"reconcile",restarted,f.arm);
    expect(settled.status).toBe("completed");expect(f.current().operations[0]).toMatchObject({terminal:true,seconds:60});
    expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(1);
  });
  it("closes an unclaimed prepared DB run only with exact terminal execution evidence",async()=>{
    const f=fixture();await startTrialWatch(f.repository,1,f.request.runId,"start",f.ledger,f.arm);
    f.observed.properties.status="Failed";
    await startTrialWatch(f.repository,1,f.request.runId,"reconcile",f.ledger,f.arm);
    expect(f.repo.failUnstartedTrial).toHaveBeenCalledWith(1,f.request.runId,f.request.snapshotDigest);
    expect(f.run.status).toBe("failed");expect(f.current().operations[0].terminal).toBe(true);
  });
  it("keeps a failed DB claim unknown, and another worker cannot claim it",async()=>{
    const f=fixture();await startTrialWatch(f.repository,1,f.request.runId,"start",f.ledger,f.arm);
    f.repo.claimTrial.mockRejectedValueOnce(Error("commit_lost"));
    await expect(executeTrialWatch(f.repository,f.request,"trial-job-one",f.ledger)).rejects.toThrow();
    expect((await f.ledger.inspect(trialHash(f.request.runId)))?.status).toBe("unknown");
    await expect(executeTrialWatch(f.repository,f.request,"trial-job-two",f.ledger)).rejects.toThrow();
    expect(f.repo.claimTrial).toHaveBeenCalledOnce();expect(f.repo.finalize).not.toHaveBeenCalled();
  });
  it("refuses a substituted execution before releasing its budget",async()=>{
    const f=fixture();await startTrialWatch(f.repository,1,f.request.runId,"start",f.ledger,f.arm);
    f.observed.properties.template.containers[0].image="wrong";
    await expect(startTrialWatch(f.repository,1,f.request.runId,"reconcile",f.ledger,f.arm)).rejects.toThrow();
    expect(f.current().operations[0].terminal).toBe(false);expect(f.repo.failUnstartedTrial).not.toHaveBeenCalled();
  });
});
