import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { modelRequestBytes } from "./generation-batch";
import { LIMITS } from "./limits";
import { ComparisonError } from "./source";
import { canonicalPropositionSources, PROPOSITION_DESCRIPTOR_MAX_BYTES, PROPOSITION_TARGET_SYSTEM,
  propositionSourceInput, propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { targetPropositionModelSchemaFor } from "./proposition-locators";
import { SOURCE_CAPACITY } from "./source-capacity";
import { sourceClaimExtractionPlan } from "./source-claim-extraction";

/** Reject the complete plan before any reservation/send. The extraction is
 * serialized once, never once per alternative branch. Twice its JSON byte cap
 * covers escaping when the object becomes the SDK's prompt string. */
export function propositionPlanSizes(plan:readonly ManagedComparisonChunk[]){
  const source=propositionSourceInput(plan);
  const claimPlan=sourceClaimExtractionPlan(plan);
  const sourceRequests=claimPlan.tasks.map(task=>({id:task.id,bytes:modelRequestBytes(task.system,task.prompt,task.schema)+1024}));
  const sourceBytes=Math.max(...sourceRequests.map(r=>r.bytes));
  const empty=canonicalPropositionSources(plan);
  const text=(n:number)=>"\ud800".repeat(n), evidence={claimNo:Number.MAX_SAFE_INTEGER,start:Number.MAX_SAFE_INTEGER,end:Number.MAX_SAFE_INTEGER,quote:text(120)};
  const drafts=plan.flatMap(c=>c.pairs.map(p=>({...p,docId:c.candidateId,baseObservation:text(120),candidateObservation:text(120),
    common:text(200),differences:text(200),unconfirmed:text(120),baseEvidence:evidence,candidateEvidence:evidence})));
  const input=propositionTargetInput(plan,drafts,empty);
  const base=modelRequestBytes(PROPOSITION_TARGET_SYSTEM,JSON.stringify(propositionTargetTransport(input)),targetPropositionModelSchemaFor(input))+1024;
  // Additional fact IDs in scope tables and field/sentence framing are bounded
  // independently of their (not duplicated) meanings.
  const scopeCount=source.sources.reduce((n,s)=>n+s.scopes.length,0);
  const metadata=scopeCount*SOURCE_CAPACITY.facts*16+drafts.length*5*16;
  return {sourceBytes,sourceRequests,sourceCalls:sourceRequests.length,totalCalls:sourceRequests.length+2,targetBaseBytes:base,descriptorAllowance:2*PROPOSITION_DESCRIPTOR_MAX_BYTES,metadataAllowance:metadata,
    targetBytes:base+2*PROPOSITION_DESCRIPTOR_MAX_BYTES+metadata};
}
export function assertPropositionPlan(plan:readonly ManagedComparisonChunk[]):void{
  const sizes=propositionPlanSizes(plan);
  if(sizes.sourceBytes>LIMITS.inputBytes||sizes.targetBytes>LIMITS.inputBytes)throw new ComparisonError("plan_limit");
}
