import { z } from "zod";
import { managedDigest } from "../patent-watch/managed-claims";
import type { ManagedBudgetState } from "../patent-watch/managed-service-budget";
import type { CloudConfiguration, CloudManifest } from "./cloud-config";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const archiveRenewalInputSchema=z.object({localCodeSha:z.string().regex(/^[a-f0-9]{40}$/),
  ownerApprovalSha256:hash,priorEvidenceSha256:hash,originalOperationDigest:hash,
  windowMs:z.number().int().positive().max(6*60*60_000)}).strict();
export const archiveRenewalReferenceSchema=z.object({sha256:hash,localCodeSha:z.string().regex(/^[a-f0-9]{40}$/),
  executionCodeSha:z.string().regex(/^[a-f0-9]{40}$/).optional()}).strict();
export const archiveRenewalRecordSchema=archiveRenewalInputSchema.extend({schema:z.literal(1),operationId:z.uuidv4(),
  requestDigest:hash,manifestDigest:hash,configurationDigest:hash,jobDigest:hash,stableOperationDigest:hash,
  targetBindingHash:hash,ownerBindingHash:hash,originalManifestExpiresAt:z.iso.datetime(),originalOperationExpiresAt:z.iso.datetime(),
  renewedAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
export const archiveRenewalName=(id:string)=>`receipts/${z.uuidv4().parse(id)}/archive-expiry-renewal.json`;
export function archiveRenewalBinding(config:CloudConfiguration,manifest:CloudManifest,job:unknown){
  return{manifestDigest:managedDigest({...manifest,packages:manifest.packages.map(p=>({...p,etag:null}))}),
    configurationDigest:managedDigest({...config,manifest:null}),jobDigest:managedDigest(job)};
}
export function stableArchiveOperationDigest(operation:ManagedBudgetState["operations"][number]){
  const {stage,stageDigest,evidenceDigests,evidenceChainDigest,...stable}=operation;
  void stage;void stageDigest;void evidenceDigests;void evidenceChainDigest;
  return managedDigest(stable);
}
