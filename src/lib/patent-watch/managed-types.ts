import { z } from "zod";
import { managedDate, validateManagedPeriod, type PublicationPeriod } from "./managed-period";
import { managedClaimContext, managedDigest, planManagedComparisons, validateManagedClaims, type ManagedClaimSet, type ManagedComparisonPlan } from "./managed-claims";
import { managedClaimReferences } from "../koho-import/managed-claim-source";
import { managedBaseSourceSchema } from "./managed-base-source";

export class ManagedWatchError extends Error {
  constructor(readonly code: "invalid_setting" | "not_found" | "unavailable" | "in_progress" | "limit" | "incomplete" | "outcome_unknown" | "expired" | "conflict") { super(code); }
}
export const managedId = z.number().int().positive().max(2_147_483_647);
export const managedHash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().refine(value => { try { managedDate(value); return true; } catch { return false; } });
export const managedSettingSchema = z.object({
  caseId: managedId,
  contractSignedOn: date,
  monitoringStartsOn: date,
  contractEndsOn: date.nullable(),
  enabled: z.boolean(),
  source: managedBaseSourceSchema,
  base: z.object({ publicationNumber: z.string().min(1).max(100), version: z.string().min(1).max(100),
    claims: z.array(z.object({ claimNo: managedId, text: z.string().min(1), dependsOn: z.array(managedId).max(1000) }).strict()).min(1).max(1000) }).strict(),
  selectedClaimNos: z.array(managedId).min(1).max(1000),
}).strict();
export type ManagedSettingInput = z.infer<typeof managedSettingSchema>;
export type ManagedSetting = ManagedSettingInput & { settingId: number; baseDigest: string };
export function parseManagedSetting(value: unknown): ManagedSettingInput {
  try {
    const input = managedSettingSchema.parse(value);
    if (input.contractEndsOn && input.contractEndsOn < input.monitoringStartsOn) throw Error();
    validateManagedClaims(input.base);
    if (input.base.claims.some(c => JSON.stringify(managedClaimReferences(c.text)) !== JSON.stringify([...c.dependsOn].sort((a,b) => a-b)))) throw Error();
    planManagedComparisons(input.base, input.selectedClaimNos, []);
    return { ...input, selectedClaimNos: [...input.selectedClaimNos].sort((a,b) => a-b) };
  } catch { throw new ManagedWatchError("invalid_setting"); }
}
export const managedBaseDigest = (setting: Pick<ManagedSettingInput, "base" | "selectedClaimNos"> & Partial<Pick<ManagedSettingInput,"source">>) => managedDigest({ base: setting.base, selectedClaimNos: [...setting.selectedClaimNos].sort((a,b) => a-b),source:setting.source??null });

export type ManagedCandidate = {
  candidateId: number;
  sourceKey: string;
  publicationDate: string;
  inventionTitle: string;
  applicationNumber: string;
  abstract: string | null;
  source: ManagedClaimSet | null;
  claimsStatus: "complete" | "review_required" | "missing";
  lexicalScore: number;
};
export type ManagedRunSnapshot = {
  schema: 1;
  setting: ManagedSetting;
  period: PublicationPeriod;
  // All considered versions, including prefilter/screening exclusions, finalized only on success.
  sourceKeys: string[];
  candidates: ManagedCandidate[];
  scannedDocuments: number;
  incompleteDocuments: number;
  sourceBytes: number;
};
export type ManagedRun = {
  runId: string;
  caseId: number;
  settingId: number;
  status: "prepared" | "running" | "completed" | "failed" | "unknown";
  snapshot: ManagedRunSnapshot;
  snapshotDigest: string;
  plan: ManagedComparisonPlan | null;
  consumedNormal: number;
  executionId: string | null;
  acceptedAt: string | null;
  deadlineAt: string | null;
};
export function validateManagedSnapshot(value: ManagedRunSnapshot): void {
  try {
    z.object({ schema: z.literal(1), setting: managedSettingSchema.extend({ settingId: managedId, baseDigest: managedHash }).strict(),
      period: z.object({ from: date, to: date }).strict(), sourceKeys: z.array(managedHash).max(100_000),
      candidates: z.array(z.object({ candidateId: managedId, sourceKey: managedHash, publicationDate: date,
        inventionTitle: z.string().max(1000), applicationNumber: z.string().max(100), abstract: z.string().max(500).nullable(),
        source: managedSettingSchema.shape.base.nullable(), claimsStatus: z.enum(["complete","review_required","missing"]),
        lexicalScore: z.number().min(0).max(1) }).strict()).max(100),
      scannedDocuments: z.number().int().nonnegative(), incompleteDocuments: z.number().int().nonnegative(),
      sourceBytes: z.number().int().nonnegative(),
    }).strict().parse(value);
    managedSettingInput(value.setting); validateManagedPeriod(value.period);
    if (value.setting.baseDigest !== managedBaseDigest(value.setting) || value.period.from < value.setting.monitoringStartsOn ||
        value.scannedDocuments !== value.sourceKeys.length || value.incompleteDocuments > value.scannedDocuments ||
        new Set(value.sourceKeys).size !== value.sourceKeys.length || new Set(value.candidates.map(c => c.candidateId)).size !== value.candidates.length) throw Error();
    const keys = new Set(value.sourceKeys), selected = new Set<string>();
    for (const candidate of value.candidates) {
      if (!keys.has(candidate.sourceKey) || selected.has(candidate.sourceKey) || candidate.publicationDate < value.setting.monitoringStartsOn ||
          candidate.publicationDate > value.period.to || (candidate.claimsStatus === "complete") !== (candidate.source !== null)) throw Error();
      selected.add(candidate.sourceKey);
      if (candidate.source) validateManagedClaims(candidate.source);
    }
  } catch { throw new ManagedWatchError("incomplete"); }
}
/** Explicit projection keeps internal setting IDs out of the strict operator-input schema. */
export function managedSettingInput(value: ManagedSetting): ManagedSettingInput {
  return parseManagedSetting({ caseId: value.caseId, contractSignedOn: value.contractSignedOn,
    monitoringStartsOn: value.monitoringStartsOn, contractEndsOn: value.contractEndsOn, enabled: value.enabled,
    base: value.base, source:value.source, selectedClaimNos: value.selectedClaimNos });
}
export function managedScreeningInput(snapshot: ManagedRunSnapshot) {
  validateManagedSnapshot(snapshot);
  return { base: managedClaimContext(snapshot.setting.base, snapshot.setting.selectedClaimNos),
    candidates: snapshot.candidates.map(c => ({ candidateId: c.candidateId, inventionTitle: c.inventionTitle,
      abstract: c.abstract, lexicalScore: c.lexicalScore, claimsStatus: c.claimsStatus })) };
}
