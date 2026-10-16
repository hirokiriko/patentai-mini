import { describe,it,expect } from "vitest";
import { TrialLedger, trialHash } from "./ledger";
import { pricedTrial,ledgerFixture } from "./ledger.test-support";
import { TRIAL_START,TRIAL_END } from "./policy";
const input=(n:number,kind:"compare"|"extract"|"storage"="extract")=>({id:trialHash(`id${n}`),intent:trialHash(`intent${n}`),kind});
const call={ordinal:1,requestSha256:"b".repeat(64),estimatedInputTokens:1000,maximumOutputTokens:100};
describe("trial lifetime ledger",()=>{
  it("retains a lost CAS acknowledgement and restart finds same intent without resend",async()=>{
    const f=ledgerFixture();f.lose();await expect(f.ledger.reserve(input(1))).rejects.toThrow("lost_ack");
    const restarted=new TrialLedger(pricedTrial(),f.io,()=>Date.parse(TRIAL_START));
    expect((await restarted.reserve(input(1))).created).toBe(false);expect(f.current().operations).toHaveLength(1);
  });
  it("allows only one concurrent Job, even with different run ids",async()=>{
    const f=ledgerFixture(),r=await Promise.allSettled([f.ledger.reserve(input(1,"compare")),f.ledger.reserve(input(2,"compare"))]);
    expect(r.filter(v=>v.status==="fulfilled")).toHaveLength(1);expect(f.current().operations).toHaveLength(1);
    await expect(f.ledger.reserve(input(3,"compare"))).rejects.toThrow("trial_job_busy");
  });
  it("does not free an unknown reservation or reserve its intent under a new id",async()=>{
    const f=ledgerFixture();await f.ledger.reserve(input(1));await f.ledger.markUnknown(input(1).id);
    await expect(f.ledger.complete(input(1).id,{persisted:true})).rejects.toThrow();
    await expect(f.ledger.reserve({...input(2),intent:input(1).intent})).rejects.toThrow();
    expect(f.current().operations[0].mini).toBe(1);
  });
  it.each(["before","end","after"])("rejects admission %s the permission window",async(which)=>{
    const f=ledgerFixture();f.advance(which==="before"?Date.parse(TRIAL_START)-1:Date.parse(TRIAL_END)+(which==="after"?1:0));
    await expect(f.ledger.reserve(input(1))).rejects.toThrow("trial_outside_period");expect(f.current().revision).toBe(0);
  });
  it("retains initial history when switching phase and repricing",async()=>{
    const p=pricedTrial();p.phase="initial";p.startsAt=TRIAL_START;p.endsAt="2026-10-17T00:30:00Z";
    const f=ledgerFixture(p);await f.ledger.reserve(input(1));await f.ledger.claimDispatch(input(1).id);
    await f.ledger.reserveCall(input(1).id,call);await f.ledger.reconcileCall(input(1).id,{ordinal:1,inputTokens:500,outputTokens:20});
    const next=pricedTrial();next.cost!.mini.inputYenPerMillion=1;
    const restarted=new TrialLedger(next,f.io,()=>Date.parse(TRIAL_START));await restarted.complete(input(1).id,{persisted:true});
    expect(f.current().operations[0]).toMatchObject({phase:"initial",yen:1,mini:1});
    await restarted.reserve(input(2));expect(f.current().operations.map(o=>o.phase)).toEqual(["initial","trial"]);
  });
  it("counts failed mini attempts and refuses the thirteenth",async()=>{
    const f=ledgerFixture();for(let i=0;i<12;i++){await f.ledger.reserve(input(i));await f.ledger.markUnknown(input(i).id);}
    await expect(f.ledger.reserve(input(12))).rejects.toThrow("trial_quantity_limit");
  });
  it("rejects shared remaining room, stale prices, ordinary threshold and storage cap",async()=>{
    for(const scenario of ["shared","stale","monthly","bytes"]){const p=pricedTrial();
      if(scenario==="shared")p.cost!.sharedRemainingYen=0;if(scenario==="stale")p.cost!.validUntil=TRIAL_START;
      if(scenario==="monthly")p.cost!.monthOtherYen=1800;
      const f=ledgerFixture(p);await expect(f.ledger.reserve({...input(1,scenario==="bytes"?"storage":"extract"),bytes:scenario==="bytes"?3*1024**3:0})).rejects.toThrow();
    }
  });
  it("requires worker claim, blocks duplicate workers and the fourth normal call",async()=>{
    const f=ledgerFixture(),i=input(1,"compare");await f.ledger.reserve(i);await f.ledger.claimDispatch(i.id);
    await expect(f.ledger.reserveCall(i.id,call)).rejects.toThrow();await f.ledger.claimWorker(i.id,"trial-job-one");
    await expect(f.ledger.claimWorker(i.id,"trial-job-two")).rejects.toThrow();
    for(let ordinal=1;ordinal<=3;ordinal++){await f.ledger.reserveCall(i.id,{...call,ordinal});await f.ledger.reconcileCall(i.id,{ordinal,inputTokens:100,outputTokens:10});}
    await expect(f.ledger.reserveCall(i.id,{...call,ordinal:4})).rejects.toThrow();
    await f.ledger.complete(i.id,{persisted:true,execution:"trial-job-one"});
    await expect(f.ledger.reserve(input(2,"compare"))).rejects.toThrow("trial_job_busy");
    await f.ledger.reconcileTerminalJob(i.id,{execution:"trial-job-one",seconds:120,databaseConfirmed:true});
    expect((await f.ledger.reserve(input(2,"compare"))).created).toBe(true);
  });
  it("settles sent usage after expiry but prevents another send",async()=>{
    const f=ledgerFixture(),i=input(1);await f.ledger.reserve(i);await f.ledger.claimDispatch(i.id);await f.ledger.reserveCall(i.id,call);
    f.advance(Date.parse(TRIAL_END));await f.ledger.reconcileCall(i.id,{ordinal:1,inputTokens:200,outputTokens:20});
    await f.ledger.complete(i.id,{persisted:true});expect(f.current().operations[0].status).toBe("complete");
    await expect(f.ledger.reserve(input(2))).rejects.toThrow("trial_outside_period");
  });
  it("prevents A/B groups from sharing identical operation ids",async()=>{
    const f=ledgerFixture();await f.ledger.reserve(input(1));const other=pricedTrial();other.storage.budget="other-budget";
    await expect(new TrialLedger(other,f.io).inspect(input(1).id)).rejects.toThrow("trial_budget_stopped");
  });
});
