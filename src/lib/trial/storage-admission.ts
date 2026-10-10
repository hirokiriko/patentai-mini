import { TrialLedger, trialHash } from "./ledger";
import { readTrialPolicy, requireTrialActive, trialPolicyDigest, TrialError } from "./policy";
import { verifyTrialBuild } from "./runtime";

export async function trialStorageAdmission(purpose:"originals"|"artifacts",key:string,bytes:Buffer,ledger=TrialLedger.configured()) {
  const p=ledger.policy;requireTrialActive(p);await verifyTrialBuild(p);
  if(purpose==="artifacts"){
    const match=/^cases\/[1-9][0-9]*\/managed-deliveries\/([a-f0-9-]{36})\/(?:snapshot\.json|pdf\.pdf|csv\.csv)$/.exec(key);
    const parent=match?await ledger.inspect(trialHash(`delivery:${match[1]}`)):null;
    if(!parent||parent.kind!=="artifact"||parent.status!=="dispatching"||parent.storageKey!==key.slice(0,key.lastIndexOf("/"))||
      parent.bytes!==48*1024**2||bytes.length>16*1024**2)throw new TrialError("trial_artifact_denied");
  }
  const intent=trialHash(JSON.stringify({purpose,key:purpose==="originals"?key.replace(/\d{13}-[a-f0-9-]{36}-/,""):key,sha:trialHash(bytes),bytes:bytes.length}));
  // The immutable key, not a random HTTP retry id, owns the write.
  const id=trialHash(`storage:${purpose}:${key}`);
  const r=await ledger.reserve({id,intent,kind:"storage",bytes:purpose==="artifacts"?0:bytes.length,storageKey:key});
  if(!r.created)throw new TrialError("trial_storage_already_reserved");
  await ledger.claimDispatch(id);
  requireTrialActive(p);
  if(trialPolicyDigest(readTrialPolicy())!==trialPolicyDigest(p))throw new TrialError();
  return {async stored(){await ledger.complete(id,{persisted:true});},async unknown(){await ledger.markUnknown(id);}};
}
