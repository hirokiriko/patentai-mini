import { sql } from "drizzle-orm";
import type { ManagedDatabase } from "../../repositories/managed-case-graph";
import { TrialLedger, trialHash } from "./ledger";
import { requireTrialActive, readTrialPolicy, TrialError } from "./policy";

export async function checkTrialDatabaseSize(db:ManagedDatabase,growth=1024**2,p=readTrialPolicy()){
  requireTrialActive(p);if(!p.cost)throw new TrialError("trial_database_limit");
  const result=await db.execute(sql`select pg_database_size(current_database())::text as bytes`);
  const current=Number((result.rows[0] as {bytes?:string})?.bytes);
  if(!Number.isSafeInteger(current)||current<p.cost.databaseBaselineBytes||current-p.cost.databaseBaselineBytes+growth>256*1024**2)
    throw new TrialError("trial_database_limit");
}

/** Lifetime growth reservations include a conservative page/index/WAL margin.
 * Actual database size is independently checked; reservations are never reset. */
export async function reserveTrialDatabase(db:ManagedDatabase,key:string,maximumPayloadBytes:number,ledger=TrialLedger.configured()) {
  const p=ledger.policy; requireTrialActive(p);
  if(!p.cost||!Number.isSafeInteger(maximumPayloadBytes)||maximumPayloadBytes<1||maximumPayloadBytes>16*1024**2)throw new TrialError("trial_database_limit");
  const growth=Math.max(1024**2,maximumPayloadBytes*4);
  await checkTrialDatabaseSize(db,growth,p);
  const id=trialHash(`database:${key}`), r=await ledger.reserve({id,intent:id,kind:"database",dbBytes:growth});
  if(!r.created)throw new TrialError("trial_database_already_reserved");
  await ledger.claimDispatch(id);
  return {async persisted(){await ledger.complete(id,{persisted:true});}};
}
