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
