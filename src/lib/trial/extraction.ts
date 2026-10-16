import { withTrialAiBudget } from "../ai-operation-budget";
import { TrialLedger, trialHash } from "./ledger";
import { TrialError } from "./policy";
import { verifyTrialBuild } from "./runtime";

/** Identity belongs to the stored draft, so a refresh cannot resend an unknown extraction. */
export async function runTrialExtraction<T>(caseId: number, draftId: number, text: string,
  generate: () => Promise<T>, persist: (result: T) => Promise<unknown>, ledger = TrialLedger.configured()) {
  if (![caseId,draftId].every(v => Number.isSafeInteger(v) && v > 0)) throw new TrialError();
  if (!text.trim() || text.length>15000) throw new TrialError("trial_input_limit");
  await verifyTrialBuild(ledger.policy);
  const intent = trialHash(JSON.stringify({ kind:"extract",caseId,draftId,text:trialHash(text) }));
  const reservation = await ledger.reserve({ id:intent,intent,kind:"extract" });
  if (!reservation.created) throw new TrialError("trial_extraction_already_reserved");
  await ledger.claimDispatch(intent);
  try {
    const result = await withTrialAiBudget({ kind:"extract",deadlineAt:Date.parse(reservation.operation.createdAt)+90_000,
      journal:{ reserve:e => ledger.reserveCall(intent,e).then(()=>undefined), reconcile:e => ledger.reconcileCall(intent,e).then(()=>undefined) } },generate);
    const saved = await persist(result);
    if (!saved) throw new TrialError("trial_result_unconfirmed");
    await ledger.complete(intent,{persisted:true}); return saved;
  } catch { await ledger.markUnknown(intent).catch(()=>undefined); throw new TrialError("trial_extraction_incomplete"); }
}
