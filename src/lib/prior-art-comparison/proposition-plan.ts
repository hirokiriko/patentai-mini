import type { ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { modelRequestBytes } from "./generation-batch";
import { LIMITS } from "./limits";
import { ComparisonError } from "./source";
import { canonicalPropositionSources, PROPOSITION_DESCRIPTOR_MAX_BYTES, PROPOSITION_SOURCE_SYSTEM, PROPOSITION_TARGET_SYSTEM,
  propositionSourceInput, propositionSourceTransport, propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { sourcePropositionModelSchemaFor, targetPropositionModelSchemaFor } from "./proposition-locators";

/** Reject the complete plan before any reservation/send. The extraction is
 * serialized once, never once per alternative branch. Twice its JSON byte cap
 * covers escaping when the object becomes the SDK's prompt string. */
export function propositionPlanSizes(plan:readonly ManagedComparisonChunk[]){
  const source=propositionSourceInput(plan);
  const sourceBytes=modelRequestBytes(PROPOSITION_SOURCE_SYSTEM,JSON.stringify(propositionSourceTransport(source)),sourcePropositionModelSchemaFor(plan))+1024;
  const empty=canonicalPropositionSources(plan);
  const text=(n:number)=>"\ud800".repeat(n), evidence={claimNo:Number.MAX_SAFE_INTEGER,start:Number.MAX_SAFE_INTEGER,end:Number.MAX_SAFE_INTEGER,quote:text(120)};
  const drafts=plan.flatMap(c=>c.pairs.map(p=>({...p,docId:c.candidateId,baseObservation:text(120),candidateObservation:text(120),
    common:text(200),differences:text(200),unconfirmed:text(120),baseEvidence:evidence,candidateEvidence:evidence})));
  const input=propositionTargetInput(plan,drafts,empty);
  const base=modelRequestBytes(PROPOSITION_TARGET_SYSTEM,JSON.stringify(propositionTargetTransport(input)),targetPropositionModelSchemaFor(input))+1024;
  // Additional fact IDs in scope tables and field/sentence framing are bounded
  // independently of their (not duplicated) meanings.
  const scopeCount=source.sources.reduce((n,s)=>n+s.scopes.length,0);
  const metadata=scopeCount*48*16+drafts.length*5*16;
  return {sourceBytes,targetBaseBytes:base,descriptorAllowance:2*PROPOSITION_DESCRIPTOR_MAX_BYTES,metadataAllowance:metadata,
    targetBytes:base+2*PROPOSITION_DESCRIPTOR_MAX_BYTES+metadata};
}
export function assertPropositionPlan(plan:readonly ManagedComparisonChunk[]):void{
  const sizes=propositionPlanSizes(plan);
  if(sizes.sourceBytes>LIMITS.inputBytes||sizes.targetBytes>LIMITS.inputBytes)throw new ComparisonError("plan_limit");
}
