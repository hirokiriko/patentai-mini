import { TrialNetworkBudget, type TrialNetworkQuery } from "./network-budget";
import type { TrialPolicy } from "./policy";

/** Deterministic durable store shared by independently constructed clients. */
export function networkBudgetFixture(policy: TrialPolicy) {
  const state={blob:{requests:0,bytes:0},arm:{requests:0,bytes:0},receipts:[] as Array<{service:string;slot:number;observed:number|null}>};
  let lost=false,proof="committed",settlementLost=false;
  const database:TrialNetworkQuery={query:async(text,values=[])=>{
    if(text.startsWith("WITH allowance")){
      const service=values[1] as "blob"|"arm",quota=state[service],bytes=Number(values[2]);
      if(quota.requests>=Number(values[3])||quota.bytes+bytes>Number(values[4]))return {rows:[]};
      quota.requests++;quota.bytes+=bytes;state.receipts.push({service,slot:quota.requests,observed:null});
      if(lost){lost=false;throw Error("unknown commit");}
      return {rows:[{slot:quota.requests,transaction_id:String(quota.requests)}]};
    }
    if(text.startsWith("SELECT pg_xact_status"))return {rows:[{status:proof}]};
    if(text.startsWith("UPDATE public.trial_network_budget")){
      const row=state.receipts.find(r=>r.service===values[1]&&r.slot===values[2]);
      if(!row||row.observed!==null)return {rows:[]};row.observed=Number(values[3]);
      if(settlementLost){settlementLost=false;throw Error("unknown settlement");}
      return {rows:[{slot:row.slot}]};
    }
    throw Error("unexpected query");
  }};
  return {state,database,budget:new TrialNetworkBudget(policy,database),restart:()=>new TrialNetworkBudget(policy,database),
    lose:()=>{lost=true;},proof:(value:string)=>{proof=value;},loseSettlement:()=>{settlementLost=true;}};
}
