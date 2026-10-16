import { TrialLedger, emptyTrialLedger, type TrialLedgerIO, type TrialLedgerState } from "./ledger";
import { trialFixture } from "./policy.test-support";
import { TRIAL_START,type TrialPolicy } from "./policy";
export function pricedTrial():TrialPolicy { return {...structuredClone(trialFixture),image:`fictional.azurecr.io/trial@sha256:${"a".repeat(64)}`,
  cost:{checkedAt:TRIAL_START,validUntil:"2026-10-18T00:00:00Z",normal:{inputYenPerMillion:500,outputYenPerMillion:3000},
    mini:{inputYenPerMillion:150,outputYenPerMillion:900},jobYenPerHour:100,initialOtherYen:0,retainedOtherYen:0,monthOtherYen:0,sharedRemainingYen:15000,databaseBaselineBytes:0}}; }
export function ledgerFixture(p=pricedTrial()){
  let state=emptyTrialLedger(p),version=0,loseAck=false;
  const io:TrialLedgerIO={read:async()=>({state:structuredClone(state),etag:String(version)}),replace:async(next,etag)=>{
    if(etag!==String(version))throw Error("conflict");state=structuredClone(next);version++;if(loseAck){loseAck=false;throw Error("lost_ack");}
  }};
  let now=Date.parse(TRIAL_START);
  return {ledger:new TrialLedger(p,io,()=>now),io,current:()=>structuredClone(state),set:(s:TrialLedgerState)=>{state=s;},
    advance:(n:number)=>{now=n;},lose:()=>{loseAck=true;}};
}
