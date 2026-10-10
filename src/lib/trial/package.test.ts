import { describe,it,expect } from "vitest";
import { manualFixture } from "../../../scripts/koho-manual-import-fixtures";
import { prepareTrialPackage } from "./package";
import { trialHash,TrialLedger } from "./ledger";
import { ledgerFixture,pricedTrial } from "./ledger.test-support";
import { TRIAL_START } from "./policy";
describe("trial whole-package admission",()=>{
  it("parses a complete fictional package and binds its receipt and claims",async()=>{
    const bytes=manualFixture("JPA",1,{publicationDate:"2026-08-12",issue:"2026-148",control:"01115"});
    const p=await prepareTrialPackage(bytes,trialHash(bytes));
    expect(p.plan.documentCount).toBe(1);expect(p.managed.sources).toHaveLength(1);expect(p.payloadBytes).toBeGreaterThan(0);
    await expect(prepareTrialPackage(bytes,"0".repeat(64))).rejects.toThrow();
  });
  it("retains unknown packages across restart and enforces two packages and two GiB",async()=>{
    const f=ledgerFixture();for(let n=0;n<2;n++){
      const id=trialHash(String(n));await f.ledger.reserve({id,intent:id,kind:"package",sourceBytes:1024**3});await f.ledger.markUnknown(id);
    }
    const restart=new TrialLedger(pricedTrial(),f.io,()=>Date.parse(TRIAL_START));
    await expect(restart.reserve({id:trialHash("3"),intent:trialHash("3"),kind:"package",sourceBytes:1})).rejects.toThrow();
    const second=ledgerFixture();await expect(second.ledger.reserve({id:trialHash("4"),intent:trialHash("4"),kind:"package",sourceBytes:2*1024**3+1})).rejects.toThrow();
  });
  it("cannot lower signed non-AI cost floors or change the baseline on a later profile",async()=>{
    const p=pricedTrial();p.cost!.monthOtherYen=1750;const f=ledgerFixture(p);
    await f.ledger.reserve({id:trialHash("a"),intent:trialHash("a"),kind:"storage"});
    const next=pricedTrial();next.cost!.normal.inputYenPerMillion=1000;
    await expect(new TrialLedger(next,f.io,()=>Date.parse(TRIAL_START)).reserve({id:trialHash("b"),intent:trialHash("b"),kind:"compare"})).rejects.toThrow();
    next.cost!.databaseBaselineBytes=1;await expect(new TrialLedger(next,f.io).read()).rejects.toThrow();
  });
});
