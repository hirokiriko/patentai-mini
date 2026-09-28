import { describe, expect, it, vi } from "vitest";
import { managedCloudFixture } from "./managed-cloud.test-support";
import { managedWatchJobTemplate, parseManagedCloudConfiguration } from "./managed-cloud-config";
import { dispatchManagedWatch, reconcileManagedWatchStart } from "./managed-cloud-dispatch";
import type { ManagedCloudStartRepository } from "../../repositories/managed-cloud-start";
import { managedBudgetedWatchFixture } from "./managed-execution-budget.test-support";
function boundary(){
  const {config}=managedBudgetedWatchFixture();let status="new",executionId:string|null=null,reserved=false;
  const order:string[]=[];
  const budget={reserveWatch:vi.fn(async()=>{order.push("budget-reserve");if(reserved)return{created:false};reserved=true;return{created:true};}),
    claimWatch:vi.fn(async()=>{order.push("budget-claim");}),markUnknown:vi.fn(async()=>{order.push("budget-unknown");})};
  const repository={
    async reserve(){order.push("db-reserve");if(status!=="new")throw Error("conflict");status="reserved";},async submitting(){order.push("db-submitting");status="submitting";},
    async get(){return {config,status,executionId,runs:[]};},async markUnknown(){status="unknown";},async recordExecution(_c:unknown,id:string){executionId=id;},
  } as unknown as ManagedCloudStartRepository;
  const metadata={id:config.jobResourceId,properties:{environmentId:config.expectedEnvironmentResourceId,configuration:{triggerType:"Manual",replicaTimeout:7200,replicaRetryLimit:0,manualTriggerConfig:{parallelism:1,replicaCompletionCount:1}},template:{containers:[{image:config.image}]}}};
  const arm=vi.fn(async(_url:string,method:"GET"|"POST",_body?:unknown):Promise<{status:number;body:unknown}>=>{void _body;order.push(method);return method==="GET"?{status:200,body:metadata}:{status:202,body:null};});
  return{config,repository,arm,budget,order};
}
describe("fixed cloud dispatch and unknown-start reconciliation",()=>{
  async function terminalBoundary(status:string){
    const b=boundary(),name=b.config.jobName+"-fixture",observed=await b.repository.get(b.config.operationId);
    observed.executionId=name;observed.status="unknown";
    observed.runs=[{...b.config.runs[0],status:"prepared",executionId:null,consumedNormal:0}];
    vi.spyOn(b.repository,"get").mockImplementation(async()=>structuredClone(observed));
    b.repository.failUnstarted=vi.fn(async()=>{observed.runs[0].status="failed";return 1;});
    const body={id:`${b.config.jobResourceId}/executions/${name}`,name,properties:{status,template:managedWatchJobTemplate(b.config)}};
    b.arm.mockResolvedValue({status:200,body});return{...b,body};
  }
  it.each(["Failed","Stopped"])("fails only proven unstarted reservations after an exact %s execution without another start",async status=>{
    const b=await terminalBoundary(status);
    expect(await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).toMatchObject({status:"unknown",executionStatus:status,runs:[{status:"failed",consumedNormal:0}]});
    expect(b.repository.failUnstarted).toHaveBeenCalledExactlyOnceWith(b.config,b.body.name);
    await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm);
    expect(b.repository.failUnstarted).toHaveBeenCalledTimes(1);
    expect(b.arm.mock.calls.every(c=>c[1]==="GET")).toBe(true);expect(b.budget.reserveWatch).not.toHaveBeenCalled();
  });
  it.each(["Running","Processing","Unknown","Succeeded"])("does not fail unstarted reservations for %s",async status=>{
    const b=await terminalBoundary(status);
    expect(await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).toMatchObject({runs:[{status:"prepared"}]});
    expect(b.repository.failUnstarted).not.toHaveBeenCalled();
  });
  function differentReferences(template:ReturnType<typeof managedWatchJobTemplate>){
    for(const e of template.containers[0].env)if("secretRef" in e)e.secretRef="fictional-api-reference";
  }
  it.each(["Failed","Stopped"])("requires a locked worker claim for differing reference names on a known %s execution",async status=>{
    const b=await terminalBoundary(status);differentReferences(b.body.properties.template);
    expect(await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).toMatchObject({runs:[{status:"failed"}]});
    expect(b.repository.failUnstarted).toHaveBeenCalledExactlyOnceWith(b.config,b.body.name,true);
    expect(b.arm.mock.calls.every(c=>c[1]==="GET")).toBe(true);expect(b.budget.reserveWatch).not.toHaveBeenCalled();
  });
  it("does not accept a reference projection when the locked claim proof is unavailable",async()=>{
    const b=await terminalBoundary("Failed");differentReferences(b.body.properties.template);
    vi.mocked(b.repository.failUnstarted).mockRejectedValue(Error("claim proof absent"));
    await expect(reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).rejects.toThrow("claim proof absent");
    expect((await b.repository.get(b.config.operationId)).runs[0].status).toBe("prepared");
  });
  it.each(["missing","duplicate","value","empty","null","extra","config","ordinary"])("rejects altered environment evidence even with projected references: %s",async field=>{
    const b=await terminalBoundary("Failed"),container=b.body.properties.template.containers[0];differentReferences(b.body.properties.template);
    const env=container.env as Array<Record<string,unknown>>,secret=env.find(e=>e.name==="AZURE_API_KEY")!;
    if(field==="missing")env.splice(env.indexOf(secret),1);
    if(field==="duplicate")env.push({...secret});
    if(field==="value")secret.value="fictional-inline";
    if(field==="empty")secret.secretRef="";
    if(field==="null")secret.secretRef=null;
    if(field==="extra")secret.unexpected=true;
    if(field==="config")env.find(e=>e.name==="MANAGED_WATCH_CONFIG_JSON")!.value="{}";
    if(field==="ordinary")env.find(e=>e.name==="AI_PROVIDER")!.value="other";
    await expect(reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).rejects.toThrow();
    expect(b.repository.failUnstarted).not.toHaveBeenCalled();
  });
  it("never uses projected secret references to discover an execution after a lost acknowledgement",async()=>{
    const b=boundary(),name=b.config.jobName+"-fixture",template=managedWatchJobTemplate(b.config);differentReferences(template);
    const record=vi.spyOn(b.repository,"recordExecution");b.repository.failUnstarted=vi.fn();
    b.arm.mockResolvedValue({status:200,body:{value:[{id:`${b.config.jobResourceId}/executions/${name}`,name,properties:{status:"Failed",template}}]}});
    expect(await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).toMatchObject({executionStatus:"Unknown",runs:[]});
    expect(record).not.toHaveBeenCalled();expect(b.repository.failUnstarted).not.toHaveBeenCalled();
  });
  it("can reconcile the exact terminal template after its dispatch permit expires",async()=>{
    const b=await terminalBoundary("Failed");b.config.expiresAt=new Date(Date.now()-60_000).toISOString();
    b.body.properties.template=managedWatchJobTemplate(b.config,false);
    expect(await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).toMatchObject({runs:[{status:"failed"}]});
    expect(b.repository.failUnstarted).toHaveBeenCalledOnce();expect(b.budget.reserveWatch).not.toHaveBeenCalled();
  });
  it.each(["id","name","image","command","env","init","http","lost"])("keeps reservations unchanged when failed execution evidence differs: %s",async field=>{
    const b=await terminalBoundary("Failed");
    if(field==="id")b.body.id+="-other";
    if(field==="name")b.body.name+="-other";
    if(field==="image")b.body.properties.template.containers[0].image+="-other";
    if(field==="command")b.body.properties.template.containers[0].command=["other"];
    if(field==="env")b.body.properties.template.containers[0].env=[];
    if(field==="init")Object.assign(b.body.properties.template,{initContainers:[{}]});
    if(field==="http")b.arm.mockResolvedValue({status:503,body:null});
    if(field==="lost")b.arm.mockRejectedValue(Error("read unavailable"));
    await expect(reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).rejects.toThrow();
    expect(b.repository.failUnstarted).not.toHaveBeenCalled();expect(b.arm.mock.calls.every(c=>c[1]==="GET")).toBe(true);
  });
  it("preserves the existing Azure v1 version through the fixed Job template and dispatch",async()=>{
    const b=boundary();b.config.ai.apiVersion="v1";
    expect(parseManagedCloudConfiguration(b.config).ai.apiVersion).toBe("v1");
    const template=managedWatchJobTemplate(b.config);
    expect(template.containers[0].env.find(e=>e.name==="AZURE_OPENAI_API_VERSION")).toEqual({name:"AZURE_OPENAI_API_VERSION",value:"v1"});
    await dispatchManagedWatch(b.repository,b.config,b.arm,b.budget);
    const sent=b.arm.mock.calls.find(c=>c[1]==="POST")![2] as typeof template;
    expect(sent.containers[0].env.find(e=>e.name==="AZURE_OPENAI_API_VERSION")).toEqual({name:"AZURE_OPENAI_API_VERSION",value:"v1"});
  });
  it.each(["", "v2", "v1/other", "v1?other=value", "v1\n"])("rejects an unapproved Azure version before dispatch: %j",async version=>{
    const b=boundary();b.config.ai.apiVersion=version;
    await expect(dispatchManagedWatch(b.repository,b.config,b.arm,b.budget)).rejects.toThrow();
    expect(b.order).toEqual([]);
  });
  it("builds only the bounded watch command and its two secret references",()=>{
    const template=managedWatchJobTemplate(managedBudgetedWatchFixture().config),c=template.containers[0];
    expect(c.resources).toEqual({cpu:2,memory:"4Gi"});expect(c.command).toEqual(["node",".koho-ops/managed/scripts/managed-watch-cloud.js"]);
    expect(c.env.filter(e=>"secretRef" in e)).toHaveLength(2);expect(JSON.stringify(template)).not.toMatch(/DATABASE_URL|KOHO_CLOUD_DATABASE_PASSWORD|AZURE_CLIENT_SECRET/);
    const config=managedCloudFixture();config.caseAllowList=[8];expect(()=>parseManagedCloudConfiguration(config)).toThrow();
  });
  it("sends start once and blocks the same reservation even after an empty 202",async()=>{
    const b=boundary();expect((await dispatchManagedWatch(b.repository,b.config,b.arm,b.budget)).status).toBe("submitting");
    expect(b.order).toEqual(["GET","budget-reserve","db-reserve","db-submitting","budget-claim","POST"]);
    await expect(dispatchManagedWatch(b.repository,b.config,b.arm,b.budget)).rejects.toThrow("conflict");
    expect(b.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(1);
  });
  it("finds one exact reserved execution after a lost ACK, without another POST",async()=>{
    const b=boundary();b.arm.mockImplementationOnce(async()=>({status:200,body:{id:b.config.jobResourceId,properties:{environmentId:b.config.expectedEnvironmentResourceId,configuration:{triggerType:"Manual",replicaTimeout:7200,replicaRetryLimit:0,manualTriggerConfig:{parallelism:1,replicaCompletionCount:1}},template:{containers:[{image:b.config.image}]}}}}))
      .mockImplementationOnce(async()=>{throw Error("lost ACK");});
    await expect(dispatchManagedWatch(b.repository,b.config,b.arm,b.budget)).rejects.toThrow("outcome_unknown");
    expect(b.budget.markUnknown).toHaveBeenCalledOnce();
    const name=b.config.jobName+"-fixture",template=managedWatchJobTemplate(b.config);
    // ARM JSON field order, null optional fields and env array order are immaterial.
    template.containers[0].env=template.containers[0].env.map(e=>Object.fromEntries(Object.entries({...e,value:"value" in e?e.value:null,secretRef:"secretRef" in e?e.secretRef:null}).reverse())) as typeof template.containers[0]["env"];
    template.containers[0].env.reverse();
    b.arm.mockImplementation(async(url)=>url.includes("/executions?")?{status:200,body:{value:[{name,id:`${b.config.jobResourceId}/executions/${name}`,properties:{template}}]}}:
      {status:200,body:{properties:{status:"Failed"}}});
    expect(await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).toMatchObject({status:"unknown",executionStatus:"Failed"});
    expect(b.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(1);expect(b.arm.mock.calls.filter(c=>c[0].includes("/executions"))).toHaveLength(2);
  });
  it("retains unknown for an unrelated or ambiguous template",async()=>{
    const b=boundary();await dispatchManagedWatch(b.repository,b.config,b.arm,b.budget);
    const template=managedWatchJobTemplate(b.config);template.containers[0].image=`fictional.azurecr.io/patentai-mini@sha256:${"f".repeat(64)}`;
    b.arm.mockResolvedValue({status:200,body:{value:[{name:"fictional-manual-unrelated",id:`${b.config.jobResourceId}/executions/fictional-manual-unrelated`,properties:{template}}]}});
    expect((await reconcileManagedWatchStart(b.repository,b.config.operationId,b.arm)).executionStatus).toBe("Unknown");
  });
  it.each(["reserve","db","submitting","claim"])("never sends POST after a %s reservation/ACK failure",async phase=>{
    const b=boundary();
    if(phase==="reserve")b.budget.reserveWatch.mockRejectedValue(Error("lost ACK"));
    if(phase==="db")vi.spyOn(b.repository,"reserve").mockRejectedValue(Error("lost ACK"));
    if(phase==="submitting")vi.spyOn(b.repository,"submitting").mockRejectedValue(Error("lost ACK"));
    if(phase==="claim")b.budget.claimWatch.mockRejectedValue(Error("lost ACK"));
    await expect(dispatchManagedWatch(b.repository,b.config,b.arm,b.budget)).rejects.toThrow();
    expect(b.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(0);
  });
  it("rejects a legacy start before any ARM/DB/budget operation",async()=>{
    const b=boundary();await expect(dispatchManagedWatch(b.repository,managedCloudFixture(),b.arm,b.budget)).rejects.toThrow();
    expect(b.order).toEqual([]);
  });
  it("rejects a Job in a different environment before any reservation or POST",async()=>{
    const b=boundary(),original=b.arm.getMockImplementation()!;b.arm.mockImplementation(async(...args)=>{
      const r=await original(...args);(r.body as {properties:{environmentId:string}}).properties.environmentId=b.config.expectedEnvironmentResourceId.replace(/fictional$/,"different");return r;
    });
    await expect(dispatchManagedWatch(b.repository,b.config,b.arm,b.budget)).rejects.toThrow();
    expect(b.order).toEqual(["GET"]);expect(b.budget.reserveWatch).not.toHaveBeenCalled();
  });
});
