import { z } from "zod";
import { managedDigest } from "./managed-claims";

// One service, one private ledger. Neither the profile version nor a caller's
// reporting period selects a new ledger or resets the release counters.
export const MANAGED_SERVICE_KEY = "patentai-standard-managed-watch";
export const managedReleaseCaps = { jobs: 24, minutes: 2880, starts: 40, normal: 900, fast: 80,
  packages: 64, bytes: 96 * 1024 ** 3, forward: 8, rollback: 2 } as const;
type Unit = keyof typeof managedReleaseCaps;
const unitKeys = Object.keys(managedReleaseCaps) as Unit[];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const yen = z.number().int().nonnegative().max(1_000_000_000);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const cases = z.array(z.number().int().positive().max(2147483647)).max(5).refine(v => new Set(v).size === v.length);
// Audit history includes release fixtures and later signed standard profiles.
// Each request/profile still has five slots; release fixtures never reset.
const historicalCases = z.array(z.number().int().positive().max(2147483647)).max(10_000)
  .refine(v => new Set(v).size === v.length);
export const managedBudgetUnitsSchema = z.object({ jobs: quantity, minutes: quantity, starts: quantity,
  normal: quantity, fast: quantity, packages: quantity, bytes: quantity, forward: quantity, rollback: quantity }).strict();
export type ManagedBudgetUnits = z.infer<typeof managedBudgetUnitsSchema>;
// Private signed values, confined to the approved completion scope and month.
// Absence preserves all historical serialized plans and profile digests.
export const managedCompletionAllowanceSchema = z.object({
  scope: z.literal("ISSUE140_COMPLETION_V2"), issue: z.literal(140), month: z.literal("2026-10"),
  ownerApprovalDigest: hash, profileDigest: hash,
  monthlyCapYen: z.number().int().min(30_000).max(50_000), cumulativeUnits: managedBudgetUnitsSchema,
  validUntil: z.iso.datetime(),
}).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-09-30T15:00:00Z") &&
  Date.parse(a.validUntil) <= Date.parse("2026-10-31T15:00:00Z") &&
  unitKeys.every(k => ["jobs", "minutes", "forward"].includes(k) || a.cumulativeUnits[k] <= managedReleaseCaps[k]));
export type ManagedCompletionAllowance = z.infer<typeof managedCompletionAllowanceSchema>;
// A signed, profile-bound supplement for this processing month only. It does
// not change the base profile, historical release caps, or Issue140 authority.
const ordinaryStandardMonthAdjustmentSchema = z.object({
  scope: z.literal("ISSUE150_STANDARD_MONTH_V1"), month: z.literal("2026-10"),
  ownerApprovalDigest: hash, profileDigest: hash, monthlyCapYen: z.literal(38331),
  jobs: z.literal(25), minutes: z.literal(3000), forward: z.literal(9),
}).strict();
// The additional repair deployment retains unresolved prior-month units.
// This decoder is not admission: the signed Local review binds the exact epoch,
// previous plan, profile, code and one new release operation.
export const managedStandardMonthAdjustmentSchema = z.discriminatedUnion("scope", [
  ordinaryStandardMonthAdjustmentSchema,
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_PRACTITIONER_EVALUATION_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.union([z.literal(100000), z.literal(102000), z.literal(103000), z.literal(109000), z.literal(114000), z.literal(119000), z.literal(124000), z.literal(136000), z.literal(142000), z.literal(148000), z.literal(157000), z.literal(163000), z.literal(170000), z.literal(176000)]),
    forward: z.union([z.literal(14), z.literal(16), z.literal(17), z.literal(18), z.literal(19), z.literal(20), z.literal(21), z.literal(22), z.literal(23), z.literal(24), z.literal(25), z.literal(26), z.literal(27), z.literal(28), z.literal(29), z.literal(30), z.literal(31), z.literal(32), z.literal(33)]),
    repairEpochDigest: hash, priorPlanDigest: hash, priorProfileDigest: hash, validUntil: z.iso.datetime(),
    // Prepared contract only: apply these additions only after explicit approval.
    // Proposal only: signed successor applies evidence cost once; no historical hold is released.
    comparisonEvidenceRepairEarmark: z.object({ aiYen: z.literal(3000), imageRetentionYen: z.literal(2230),
      nonAiYen: z.literal(2454), storageYen: z.literal(800) }).strict().optional(),
    comparisonEvidenceCorrectiveEarmark: z.object({ aiYen: z.literal(3000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    comparisonAssessmentRepairEarmark: z.object({ aiYen: z.literal(3000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    sourceActorLocatorRepairEarmark: z.object({ aiYen: z.literal(3000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    comparisonPromptRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    comparisonPromptCorrectiveEarmark: z.object({ aiYen: z.literal(3000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    comparisonCorrectiveEarmark: z.object({ aiYen: z.literal(3000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    comparisonDiagnosticsEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1227), storageYen: z.literal(400) }).strict().optional(),
    generationGuardRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    reviewEvidenceLocatorsRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    reviewLiteralConditionsRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    reviewClaimScopeRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    reviewPossessionRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    sourceHeatRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    sourceOutputRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    reviewSourceIdsRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    branchRepairEarmark: z.object({ aiYen: z.literal(2000), imageRetentionYen: z.literal(1115),
      nonAiYen: z.literal(1217), storageYen: z.literal(400) }).strict().optional(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115),
      additionalProductionAiYen: z.literal(1238), additionalImageRetentionYen: z.literal(1115),
      reservationRepairProductionAiYen: z.literal(1238), reservationRepairImageRetentionYen: z.literal(1115),
      bindingRepairProductionAiYen: z.literal(1238), bindingRepairImageRetentionYen: z.literal(1115),
      reviewScopeRepairProductionAiYen: z.literal(1238), reviewScopeRepairImageRetentionYen: z.literal(1115),
      evaluationAiYen: z.literal(6000), evaluationImageRetentionYen: z.literal(2230),
      evaluationNonAiYen: z.literal(2434), evaluationStorageYen: z.literal(800) }).strict(),
  }).strict().refine(a => (a.sourceActorLocatorRepairEarmark
      ? a.comparisonAssessmentRepairEarmark !== undefined && a.comparisonEvidenceCorrectiveEarmark !== undefined && a.comparisonPromptCorrectiveEarmark !== undefined && a.comparisonPromptRepairEarmark !== undefined && a.comparisonEvidenceRepairEarmark !== undefined && a.comparisonCorrectiveEarmark !== undefined && a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 176000 && [32,33].includes(a.forward)
      : a.comparisonAssessmentRepairEarmark
      ? a.comparisonEvidenceCorrectiveEarmark !== undefined && a.comparisonPromptCorrectiveEarmark !== undefined && a.comparisonPromptRepairEarmark !== undefined && a.comparisonEvidenceRepairEarmark !== undefined && a.comparisonCorrectiveEarmark !== undefined && a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 170000 && [31,32].includes(a.forward)
      : a.comparisonEvidenceCorrectiveEarmark
      ? a.comparisonPromptCorrectiveEarmark !== undefined && a.comparisonPromptRepairEarmark !== undefined && a.comparisonEvidenceRepairEarmark !== undefined && a.comparisonCorrectiveEarmark !== undefined && a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 163000 && [30,31].includes(a.forward)
      : a.comparisonEvidenceRepairEarmark
      ? a.comparisonPromptCorrectiveEarmark !== undefined && a.comparisonPromptRepairEarmark !== undefined && a.comparisonCorrectiveEarmark !== undefined && a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 157000 && [29,30].includes(a.forward)
      : a.comparisonPromptCorrectiveEarmark
      ? a.comparisonPromptRepairEarmark !== undefined && a.comparisonCorrectiveEarmark !== undefined && a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 148000 && [28,29].includes(a.forward)
      : a.comparisonPromptRepairEarmark
      ? a.comparisonCorrectiveEarmark !== undefined && a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 142000 && [27,28].includes(a.forward)
      : a.comparisonCorrectiveEarmark
      ? a.comparisonDiagnosticsEarmark !== undefined && a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 136000 && [26,27].includes(a.forward)
      : a.comparisonDiagnosticsEarmark
      ? a.generationGuardRepairEarmark !== undefined && a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 136000 && [25,26].includes(a.forward)
      : a.generationGuardRepairEarmark
      ? a.reviewEvidenceLocatorsRepairEarmark !== undefined && a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 124000 && [24,25].includes(a.forward)
      : a.reviewEvidenceLocatorsRepairEarmark
      ? a.reviewLiteralConditionsRepairEarmark !== undefined && a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 119000 && [23,24].includes(a.forward)
      : a.reviewLiteralConditionsRepairEarmark
      ? a.reviewClaimScopeRepairEarmark !== undefined && a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 114000 && [22,23].includes(a.forward)
      : a.reviewClaimScopeRepairEarmark
      ? a.reviewPossessionRepairEarmark !== undefined && a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 109000 && [21,22].includes(a.forward)
      : a.reviewPossessionRepairEarmark
      ? a.sourceHeatRepairEarmark !== undefined && a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 103000 && [20,21].includes(a.forward)
      : a.sourceHeatRepairEarmark
      ? a.sourceOutputRepairEarmark !== undefined && a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 102000 && [19,20].includes(a.forward)
      : a.sourceOutputRepairEarmark
      ? a.reviewSourceIdsRepairEarmark !== undefined && a.branchRepairEarmark !== undefined && a.monthlyCapYen === 102000 && [18,19].includes(a.forward)
      : a.reviewSourceIdsRepairEarmark
      ? a.branchRepairEarmark !== undefined && a.monthlyCapYen === 102000 && [17,18].includes(a.forward)
      : a.monthlyCapYen === 100000 && (a.branchRepairEarmark ? [16,17] : [14,16]).includes(a.forward)) &&
    Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_REPAIR_STANDARD_MONTH_V1"), forward: z.literal(10),
    repairEpochDigest: hash, priorPlanDigest: hash,
  }).strict(),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_NOVEMBER_REPAIR_MONTH_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.number().int().min(38331).max(53607),
    forward: z.union([z.literal(9), z.literal(10)]),
    repairEpochDigest: hash, priorPlanDigest: hash, validUntil: z.iso.datetime(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115) }).strict(),
  }).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.literal(70000), forward: z.union([z.literal(10), z.literal(11)]),
    repairEpochDigest: hash, priorPlanDigest: hash, priorProfileDigest: hash, validUntil: z.iso.datetime(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115),
      additionalProductionAiYen: z.literal(1238), additionalImageRetentionYen: z.literal(1115) }).strict(),
  }).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.literal(70000), forward: z.union([z.literal(11), z.literal(12)]),
    repairEpochDigest: hash, priorPlanDigest: hash, priorProfileDigest: hash, validUntil: z.iso.datetime(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115),
      additionalProductionAiYen: z.literal(1238), additionalImageRetentionYen: z.literal(1115),
      reservationRepairProductionAiYen: z.literal(1238), reservationRepairImageRetentionYen: z.literal(1115) }).strict(),
  }).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.literal(70000), forward: z.union([z.literal(12), z.literal(13)]),
    repairEpochDigest: hash, priorPlanDigest: hash, priorProfileDigest: hash, validUntil: z.iso.datetime(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115),
      additionalProductionAiYen: z.literal(1238), additionalImageRetentionYen: z.literal(1115),
      reservationRepairProductionAiYen: z.literal(1238), reservationRepairImageRetentionYen: z.literal(1115) }).strict(),
  }).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_NOVEMBER_BINDING_REPAIR_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.literal(70000), forward: z.union([z.literal(12), z.literal(13)]),
    repairEpochDigest: hash, priorPlanDigest: hash, priorProfileDigest: hash, validUntil: z.iso.datetime(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115),
      additionalProductionAiYen: z.literal(1238), additionalImageRetentionYen: z.literal(1115),
      reservationRepairProductionAiYen: z.literal(1238), reservationRepairImageRetentionYen: z.literal(1115),
      bindingRepairProductionAiYen: z.literal(1238), bindingRepairImageRetentionYen: z.literal(1115) }).strict(),
  }).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
  ordinaryStandardMonthAdjustmentSchema.extend({
    scope: z.literal("ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1"), month: z.literal("2026-11"),
    monthlyCapYen: z.literal(70000), forward: z.union([z.literal(13), z.literal(14)]),
    repairEpochDigest: hash, priorPlanDigest: hash, priorProfileDigest: hash, validUntil: z.iso.datetime(),
    executionEarmark: z.object({ forecastBaseYen: z.number().int().nonnegative(),
      productionAiYen: z.literal(1238), imageRetentionYen: z.literal(1115),
      additionalProductionAiYen: z.literal(1238), additionalImageRetentionYen: z.literal(1115),
      reservationRepairProductionAiYen: z.literal(1238), reservationRepairImageRetentionYen: z.literal(1115),
      bindingRepairProductionAiYen: z.literal(1238), bindingRepairImageRetentionYen: z.literal(1115),
      reviewScopeRepairProductionAiYen: z.literal(1238), reviewScopeRepairImageRetentionYen: z.literal(1115) }).strict(),
  }).strict().refine(a => Date.parse(a.validUntil) > Date.parse("2026-10-31T15:00:00Z") &&
    Date.parse(a.validUntil) <= Date.parse("2026-11-30T15:00:00Z")),
]);
export type ManagedStandardMonthAdjustment = z.infer<typeof managedStandardMonthAdjustmentSchema>;
export const emptyManagedBudgetUnits = (): ManagedBudgetUnits => ({ jobs: 0, minutes: 0, starts: 0, normal: 0,
  fast: 0, packages: 0, bytes: 0, forward: 0, rollback: 0 });
const pools = z.object({ remaining: yen, storage: yen, recovery: yen }).strict();
type Pool = keyof z.infer<typeof pools>;
const poolKeys: Pool[] = ["remaining", "storage", "recovery"];
export const managedBudgetProfileSchema = z.object({ schema: z.literal(1), serviceKey: z.literal(MANAGED_SERVICE_KEY),
  targetBindingHash: hash, ownerBindingHash: hash, companyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), cases,
  monthlyCapYen: z.number().int().positive().max(30_000), monthlyUnits: managedBudgetUnitsSchema,
  pricingDigest: hash, measurementDigest: hash, goEvidenceDigest: hash }).strict();
export type ManagedBudgetProfile = z.infer<typeof managedBudgetProfileSchema>;
export const managedBudgetRequestSchema = z.object({ operationId: z.uuidv4(), requestDigest: hash,
  scope: z.enum(["release", "standard"]), kind: z.enum(["import", "watch", "delivery", "backup", "recovery", "deploy", "validation"]),
  profileDigest: hash.nullable(), pricingDigest: hash, cases, reservationYen: yen.refine(v => v > 0), units: managedBudgetUnitsSchema }).strict();
type Request = z.infer<typeof managedBudgetRequestSchema>;
const operationSchema = managedBudgetRequestSchema.extend({ intentDigest: hash, processingMonth: month,
  reservedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), stage: z.enum(["unused", "ready", "claimed", "done"]),
  stageDigest: hash.optional(),
  start: z.enum(["ready", "claimed"]), unknown: z.boolean(), actualYen: yen.nullable(), observedYen: yen.nullable(), reviewRequired: z.boolean(),
  knownUnits: managedBudgetUnitsSchema.partial().strict(), evidenceDigests: z.array(hash).max(64),
  evidenceChainDigest: hash, lastProofSequence: quantity,
  settlements: z.array(z.object({ sequence: quantity.refine(v => v > 0), evidenceDigest: hash, proofDigest: hash }).strict()).max(64) }).strict();
type Operation = z.infer<typeof operationSchema>;
// The separately signed Issue #129 release allowance is confined to its
// approved processing month. Omission preserves historical plan digests.
// The schema ceiling is the existing public release ceiling, not authority to
// spend it: the exact OWNER allowance is in the signed private month review.
export const managedReleaseMonthlyCapSchema = z.number().int().min(30_000).max(50_000);
const planSchema = z.object({ month, baseYen: yen, pools, pricingDigest: hash, evidenceDigests: z.array(hash).min(1).max(128),
  standardMonthAdjustment: managedStandardMonthAdjustmentSchema.optional(),
  releaseMonthlyCapYen: managedReleaseMonthlyCapSchema.optional(), completionAllowance: managedCompletionAllowanceSchema.optional() }).strict()
  .refine(p => (!p.standardMonthAdjustment || p.standardMonthAdjustment.month === p.month) &&
    (p.releaseMonthlyCapYen === undefined || p.month === "2026-09") &&
    (!p.completionAllowance || (p.month === p.completionAllowance.month && p.releaseMonthlyCapYen === undefined)));
export const managedBudgetStateSchema = z.object({ schema: z.literal(1), serviceKey: z.literal(MANAGED_SERVICE_KEY),
  targetBindingHash: hash, activeProfileDigest: hash.nullable(), cases: historicalCases, lastTrustedAt: z.iso.datetime(),
  releaseTailYen: yen, legacyUnknownYen: yen, openingEvidenceDigest: hash,
  administration: z.array(z.object({ sequence: quantity.refine(v => v > 0), digest: hash }).strict()).max(1200),
  plans: z.array(planSchema).max(1200), operations: z.array(operationSchema).max(10_000) }).strict();
export type ManagedBudgetState = z.infer<typeof managedBudgetStateSchema>;
// Created only by the fixed private-Blob adapter. Never accept these fields from stdin/HTTP.
export type ManagedBudgetClock = { blobDate: Date; maximumActionMs: number };
export class ManagedBudgetError extends Error { constructor() { super("managed_budget_stopped"); } }
function check(value: unknown): asserts value { if (!value) throw new ManagedBudgetError(); }
function sum(values: number[]) { const n = values.reduce((a, b) => a + b, 0); check(Number.isSafeInteger(n)); return n; }
function intent(o: Request): Request { return { operationId: o.operationId, requestDigest: o.requestDigest, scope: o.scope,
  kind: o.kind, profileDigest: o.profileDigest, pricingDigest: o.pricingDigest, cases: o.cases,
  reservationYen: o.reservationYen, units: o.units }; }
function cost(o: Operation) { return Math.max(o.actualYen ?? o.reservationYen, o.observedYen ?? 0); }
function used(o: Operation, k: Unit) { return o.knownUnits[k] ?? o.units[k]; }
function closed(o: Operation) { return o.actualYen !== null && o.actualYen >= (o.observedYen ?? 0) &&
  unitKeys.every(k => o.knownUnits[k] !== undefined); }
function poolOf(o: Request): Pool { return o.kind === "recovery" || o.units.rollback > 0 ? "recovery" :
  o.kind === "delivery" || o.kind === "backup" ? "storage" : "remaining"; }
function poolUsed(s: ManagedBudgetState, m: string, pool: Pool) {
  return sum(s.operations.filter(o => o.processingMonth === m && poolOf(o) === pool).map(cost));
}
export function managedBudgetForecast(s: ManagedBudgetState, m: string) {
  const plan = s.plans.find(p => p.month === m); check(plan);
  const carry = sum([s.legacyUnknownYen, ...s.operations.filter(o => o.processingMonth < m && !closed(o)).map(cost)]);
  // Operations allocate a pool, not a second charge. Observed overruns remain visible.
  return sum([plan.baseYen, carry, ...poolKeys.map(p => Math.max(plan.pools[p], poolUsed(s, m, p)))]);
}
function totals(s: ManagedBudgetState, scope: "release" | "month", m: string) {
  const result = emptyManagedBudgetUnits();
  for (const k of unitKeys) result[k] = sum(s.operations.map(o => scope === "release" ?
    (o.scope === "release" ? used(o, k) : 0) : o.processingMonth === m ? used(o, k) :
      o.processingMonth < m && !closed(o) && o.knownUnits[k] === undefined ? o.units[k] : 0));
  return result;
}
/** Called only with the installed plan or an independently verified admin review.
 * Counts every historical operation, including unresolved reservations, once. */
export function checkManagedCompletionBudget(s: ManagedBudgetState, value: unknown, clock: ManagedBudgetClock) {
  const a = managedCompletionAllowanceSchema.parse(value), at = clock.blobDate.getTime();
  check(new Date(at + 9 * 60 * 60_000).toISOString().slice(0, 7) === a.month &&
    at + clock.maximumActionMs < Date.parse(a.validUntil));
  check(s.activeProfileDigest === a.profileDigest && managedBudgetForecast(s, a.month) <= a.monthlyCapYen);
  for (const k of unitKeys) check(sum(s.operations.map(o => used(o, k))) <= a.cumulativeUnits[k]);
  return a;
}
function seal(value: ManagedBudgetState) {
  const s = managedBudgetStateSchema.parse(value);
  check(new Set(s.plans.map(p => p.month)).size === s.plans.length);
  check(new Set(s.operations.map(o => o.operationId)).size === s.operations.length);
  check(new Set(s.operations.map(o => o.requestDigest)).size === s.operations.length);
  check(new Set(s.administration.map(r => r.digest)).size === s.administration.length &&
    s.administration.every((r, i) => r.sequence === i + 1));
  check(Buffer.byteLength(JSON.stringify({ ...s, operations: [] })) <= 1024 ** 2);
  check(s.operations.length * 20 * 1024 + 1024 ** 2 <= 16 * 1024 ** 2);
  check(new Set(s.operations.filter(o => o.scope === "release").flatMap(o => o.cases)).size <= 5);
  for (const o of s.operations) {
    check(o.intentDigest === managedDigest(intent(o)) && o.cases.every(id => s.cases.includes(id)));
    check(s.plans.some(p => p.month === o.processingMonth));
    const reserved = Date.parse(o.reservedAt), expiry = Date.parse(o.expiresAt), jst = new Date(reserved + 9 * 60 * 60_000);
    const monthEnd = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 60 * 60_000;
    check(reserved <= Date.parse(s.lastTrustedAt) && o.processingMonth === jst.toISOString().slice(0, 7) &&
      expiry > reserved && expiry <= Math.min(reserved + 6 * 60 * 60_000, monthEnd));
    check(o.scope === "standard" ? o.profileDigest !== null : o.profileDigest === null);
    check(o.kind === "import" ? o.stage !== "unused" && (o.start !== "claimed" || o.stage === "done") : o.stage === "unused");
    if (o.stageDigest) check(o.kind === "import" && o.stage === "done");
    check(o.actualYen === null || unitKeys.every(k => o.knownUnits[k] !== undefined));
    check(o.settlements.length === Math.min(o.lastProofSequence, 64));
    check(new Set(o.settlements.map(p => p.evidenceDigest)).size === o.settlements.length &&
      o.settlements.every((p, i) => p.sequence === o.lastProofSequence - o.settlements.length + i + 1));
  }
  check(Buffer.byteLength(JSON.stringify(s)) <= 16 * 1024 ** 2);
  // Do not reject recorded overruns: evidence must survive even when admission stops.
  return s;
}
export function validateManagedBudgetState(value: unknown, expectedTargetBindingHash: string) {
  const s = seal(managedBudgetStateSchema.parse(value)); check(s.targetBindingHash === hash.parse(expectedTargetBindingHash)); return s;
}
function current(value: unknown, clock: ManagedBudgetClock) {
  const s = seal(managedBudgetStateSchema.parse(value)), ms = clock.blobDate.getTime();
  check(Number.isFinite(ms) && ms >= Date.parse(s.lastTrustedAt));
  check(Number.isSafeInteger(clock.maximumActionMs) && clock.maximumActionMs > 0 && clock.maximumActionMs <= 6 * 60 * 60_000);
  const jst = new Date(ms + 9 * 60 * 60_000), m = jst.toISOString().slice(0, 7);
  const end = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 60 * 60_000;
  s.lastTrustedAt = clock.blobDate.toISOString();
  return { s, ms, month: m, end };
}
function active(s: ManagedBudgetState, value: unknown) {
  const p = managedBudgetProfileSchema.parse(value);
  check(managedDigest(p) === s.activeProfileDigest && p.targetBindingHash === s.targetBindingHash);
  for (const k of unitKeys) check(p.monthlyUnits[k] <= managedReleaseCaps[k]);
  return p;
}
function standardMonthLimits(s: ManagedBudgetState, m: string, profile: ManagedBudgetProfile) {
  const adjustment = s.plans.find(p => p.month === m)?.standardMonthAdjustment;
  if (adjustment) check(adjustment.month === m && adjustment.profileDigest === managedDigest(profile));
  return { adjustment, monthlyCapYen: adjustment?.monthlyCapYen ?? profile.monthlyCapYen,
    units: { ...profile.monthlyUnits, ...(adjustment ? {
      jobs: adjustment.jobs, minutes: adjustment.minutes, forward: adjustment.forward } : {}) } };
}
function executionCompletion(s: ManagedBudgetState, m: string, hasAdjustment: boolean) {
  const completion = s.plans.find(p => p.month === m)?.completionAllowance;
  return hasAdjustment && completion?.profileDigest !== s.activeProfileDigest ? undefined : completion;
}
function admit(s: ManagedBudgetState, m: string, profile?: ManagedBudgetProfile, maximumActionMs = 1) {
  check(!s.operations.some(o => o.reviewRequired));
  const plan = s.plans.find(p => p.month === m);
  if (plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1") {
    // Twelve is an explicit stopped plan, even when observed consumption fits.
    check(plan.standardMonthAdjustment.forward === 13);
  }
  if (plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1") check(plan.standardMonthAdjustment.forward === 14);
  if (plan?.standardMonthAdjustment?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1")
    check(plan.standardMonthAdjustment.forward === (plan.standardMonthAdjustment.sourceActorLocatorRepairEarmark ? 33 :
      plan.standardMonthAdjustment.comparisonAssessmentRepairEarmark ? 32 :
      plan.standardMonthAdjustment.comparisonEvidenceCorrectiveEarmark ? 31 :
      plan.standardMonthAdjustment.comparisonEvidenceRepairEarmark ? 30 :
      plan.standardMonthAdjustment.comparisonPromptCorrectiveEarmark ? 29 :
      plan.standardMonthAdjustment.comparisonPromptRepairEarmark ? 28 :
      plan.standardMonthAdjustment.comparisonCorrectiveEarmark ? 27 :
      plan.standardMonthAdjustment.comparisonDiagnosticsEarmark ? 26 :
      plan.standardMonthAdjustment.generationGuardRepairEarmark ? 25 :
      plan.standardMonthAdjustment.reviewEvidenceLocatorsRepairEarmark ? 24 :
      plan.standardMonthAdjustment.reviewLiteralConditionsRepairEarmark ? 23 :
      plan.standardMonthAdjustment.reviewClaimScopeRepairEarmark ? 22 :
      plan.standardMonthAdjustment.reviewPossessionRepairEarmark ? 21 :
      plan.standardMonthAdjustment.sourceHeatRepairEarmark ? 20 :
      plan.standardMonthAdjustment.sourceOutputRepairEarmark ? 19 :
      plan.standardMonthAdjustment.reviewSourceIdsRepairEarmark ? 18 :
      plan.standardMonthAdjustment.branchRepairEarmark ? 17 : 16));
  const limits = profile && standardMonthLimits(s, m, profile);
  if (plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1" ||
      plan?.standardMonthAdjustment?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1") {
    check(profile !== undefined &&
      Date.parse(s.lastTrustedAt) + maximumActionMs < Date.parse(plan.standardMonthAdjustment.validUntil));
  }
  // A prior profile's completion allowance remains immutable history. A new
  // profile may start only under its own signed ordinary month supplement.
  const completion = executionCompletion(s, m, !!limits?.adjustment);
  if (completion) checkManagedCompletionBudget(s, completion, { blobDate: new Date(s.lastTrustedAt), maximumActionMs });
  const releaseCap = plan?.releaseMonthlyCapYen ?? 30_000;
  check(managedBudgetForecast(s, m) <= (limits?.adjustment ? limits.monthlyCapYen :
    profile && completion ? completion.monthlyCapYen : profile?.monthlyCapYen ?? releaseCap));
  check(sum([s.releaseTailYen, ...s.operations.filter(o => o.scope === "release").map(cost)]) <= 50_000);
  const release = totals(s, "release", m);
  for (const k of unitKeys) check(release[k] <= managedReleaseCaps[k]);
  if (profile) { check(profile.pricingDigest === s.plans.find(p => p.month === m)?.pricingDigest);
    const total = totals(s, "month", m); for (const k of unitKeys)
      if (limits?.adjustment || !completion || !["jobs", "minutes", "forward"].includes(k)) check(total[k] <= limits!.units[k]); }
}
/** Issue150 must fit the ordinary active profile, even when Issue140's signed
 * completion exception is installed. This grants no new allowance/state. */
export function checkManagedStandardBudget(value: unknown, profile: unknown, clock: ManagedBudgetClock) {
  const { s, month: m } = current(value, clock), p = active(s, profile);
  admit(s, m, p, clock.maximumActionMs);
  const limits = standardMonthLimits(s, m, p);
  check(p.pricingDigest === s.plans.find(plan => plan.month === m)?.pricingDigest &&
    managedBudgetForecast(s, m) <= limits.monthlyCapYen);
  const total = totals(s, "month", m);
  for (const k of unitKeys) check(total[k] <= limits.units[k]);
}
/** Recheck the same authority at reservation and execution. An old profile's
 * completion allowance becomes history only under a valid ordinary supplement;
 * its expiry still bounds executions for the profile it actually authorizes. */
export function checkManagedExecutionBudget(value: unknown, profile: ManagedBudgetProfile | null | undefined, clock: ManagedBudgetClock) {
  const { s, month: m } = current(value, clock);
  const adjustment = s.plans.find(p => p.month === m)?.standardMonthAdjustment;
  if (adjustment?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1" ||
      adjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1" ||
      adjustment?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1" ||
      adjustment?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1" ||
      adjustment?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1" ||
      adjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1" ||
      adjustment?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1") check(profile !== null && profile !== undefined);
  const hasAdjustment = !!profile && !!adjustment;
  if (hasAdjustment) checkManagedStandardBudget(s, profile, clock);
  const completion = executionCompletion(s, m, hasAdjustment);
  if (completion) checkManagedCompletionBudget(s, completion, clock);
  return completion;
}
function find(s: ManagedBudgetState, id: string) { const o = s.operations.find(o => o.operationId === id); check(o); return o; }
function evidence(o: Operation, digest: string) {
  hash.parse(digest);
  if (o.evidenceDigests.includes(digest)) return;
  o.evidenceChainDigest = managedDigest({ previous: o.evidenceChainDigest, digest });
  if (o.evidenceDigests.length === 64) o.reviewRequired = true;
  o.evidenceDigests = [...o.evidenceDigests, digest].slice(-64);
}

/** Administrative evidence must be checked by the adapter before these transitions. */
export function setManagedMonthPlan(value: unknown, input: { baseYen: number; pools: z.infer<typeof pools>;
  pricingDigest: string; evidenceDigest: string; releaseTailYen: number; reviewedOperationIds?: string[];
  releaseMonthlyCapYen?: number; completionAllowance?: ManagedCompletionAllowance;
  standardMonthAdjustment?: ManagedStandardMonthAdjustment }, clock: ManagedBudgetClock) {
  const { s, month: m } = current(value, clock), old = s.plans.find(p => p.month === m);
  if (input.standardMonthAdjustment?.scope === "ISSUE150_REPAIR_STANDARD_MONTH_V1") {
    check(old !== undefined && managedDigest(old) === input.standardMonthAdjustment.priorPlanDigest);
    check(input.baseYen === old.baseYen && managedDigest(input.pools) === managedDigest(old.pools) &&
      input.releaseTailYen === s.releaseTailYen &&
      managedDigest(input.completionAllowance ?? null) === managedDigest(old.completionAllowance ?? null) &&
      (input.reviewedOperationIds?.length ?? 0) === 0);
  }
  if (input.standardMonthAdjustment?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" ||
      old?.standardMonthAdjustment?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1") {
    const adjustment = input.standardMonthAdjustment, previous = old?.standardMonthAdjustment;
    check(adjustment?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
      old !== undefined && managedDigest(old) === adjustment.priorPlanDigest &&
      adjustment.priorProfileDigest === s.activeProfileDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0);
    const { evaluationAiYen, evaluationImageRetentionYen, evaluationNonAiYen, evaluationStorageYen,
      ...priorEarmark } = adjustment.executionEarmark;
    if (adjustment.sourceActorLocatorRepairEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonAssessmentRepairEarmark !== undefined);
    if (adjustment.comparisonAssessmentRepairEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonEvidenceCorrectiveEarmark !== undefined);
    if (adjustment.comparisonEvidenceCorrectiveEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonEvidenceRepairEarmark !== undefined);
    if (adjustment.comparisonEvidenceRepairEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonPromptCorrectiveEarmark !== undefined);
    if (adjustment.comparisonPromptCorrectiveEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonPromptRepairEarmark !== undefined);
    if (adjustment.comparisonPromptRepairEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonCorrectiveEarmark !== undefined);
    if (adjustment.comparisonCorrectiveEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.comparisonDiagnosticsEarmark !== undefined);
    if (adjustment.comparisonDiagnosticsEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.generationGuardRepairEarmark !== undefined);
    if (adjustment.generationGuardRepairEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.reviewEvidenceLocatorsRepairEarmark !== undefined);
    if (adjustment.reviewEvidenceLocatorsRepairEarmark !== undefined)
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" && previous.reviewLiteralConditionsRepairEarmark !== undefined);
    if (previous?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1") {
      // One separately signed evaluation supplement: preserve every historical
      // hold, reserve two evaluation attempts plus one OWNER use, and at most
      // two deployment shortfalls. Rebinding never replenishes these amounts.
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && adjustment.reviewClaimScopeRepairEarmark === undefined && adjustment.reviewPossessionRepairEarmark === undefined && adjustment.sourceHeatRepairEarmark === undefined && adjustment.sourceOutputRepairEarmark === undefined && adjustment.reviewSourceIdsRepairEarmark === undefined && adjustment.branchRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 14 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        managedDigest(priorEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + evaluationAiYen + evaluationImageRetentionYen + evaluationNonAiYen + evaluationStorageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 1070 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.branchRepairEarmark === undefined && adjustment.branchRepairEarmark !== undefined) {
      // One further signed branch-repair trial. Retain the failed evaluations
      // and the unused OWNER hold; later rebinds cannot replenish this addition.
      const extra = adjustment.branchRepairEarmark;
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && adjustment.reviewClaimScopeRepairEarmark === undefined && adjustment.reviewPossessionRepairEarmark === undefined && adjustment.sourceHeatRepairEarmark === undefined && adjustment.sourceOutputRepairEarmark === undefined && adjustment.reviewSourceIdsRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 16 && adjustment.forward === 17 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.branchRepairEarmark !== undefined && previous.reviewSourceIdsRepairEarmark === undefined &&
        adjustment.reviewSourceIdsRepairEarmark !== undefined) {
      // One separately approved fact-ID repair trial. Preserve the branch
      // repair and OWNER holds; subsequent rebinds cannot replenish it.
      const extra = adjustment.reviewSourceIdsRepairEarmark;
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && adjustment.reviewClaimScopeRepairEarmark === undefined && adjustment.reviewPossessionRepairEarmark === undefined && adjustment.sourceHeatRepairEarmark === undefined && adjustment.sourceOutputRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 17 && adjustment.forward === 18 &&
        previous.monthlyCapYen === 100000 && adjustment.monthlyCapYen === 102000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.reviewSourceIdsRepairEarmark !== undefined && previous.sourceOutputRepairEarmark === undefined &&
        adjustment.sourceOutputRepairEarmark !== undefined) {
      // One separately signed source-output repair supplement. Preserve every
      // old hold and the OWNER reserve; rebinds cannot replenish this addition.
      const extra = adjustment.sourceOutputRepairEarmark;
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && adjustment.reviewClaimScopeRepairEarmark === undefined && adjustment.reviewPossessionRepairEarmark === undefined && adjustment.sourceHeatRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 18 && adjustment.forward === 19 &&
        previous.monthlyCapYen === 102000 && adjustment.monthlyCapYen === 102000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.sourceOutputRepairEarmark !== undefined && previous.sourceHeatRepairEarmark === undefined &&
        adjustment.sourceHeatRepairEarmark !== undefined) {
      // One separately signed heat-object repair supplement. Retain all prior
      // unresolved trials and the OWNER hold; no rebind replenishes this unit.
      const extra = adjustment.sourceHeatRepairEarmark;
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && adjustment.reviewClaimScopeRepairEarmark === undefined && adjustment.reviewPossessionRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 19 && adjustment.forward === 20 &&
        previous.monthlyCapYen === 102000 && adjustment.monthlyCapYen === 102000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.sourceHeatRepairEarmark !== undefined && previous.reviewPossessionRepairEarmark === undefined &&
        adjustment.reviewPossessionRepairEarmark !== undefined) {
      // One separately signed review-possession repair supplement. Retain all prior
      // unresolved trials and the OWNER hold; no rebind replenishes this unit.
      const extra = adjustment.reviewPossessionRepairEarmark;
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && adjustment.reviewClaimScopeRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 20 && adjustment.forward === 21 &&
        previous.monthlyCapYen === 102000 && adjustment.monthlyCapYen === 103000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.sourceHeatRepairEarmark) === managedDigest(previous.sourceHeatRepairEarmark) &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.reviewPossessionRepairEarmark !== undefined && previous.reviewClaimScopeRepairEarmark === undefined &&
        adjustment.reviewClaimScopeRepairEarmark !== undefined) {
      // One separately signed review claim-scope repair supplement. Retain all prior
      // unresolved trials and the OWNER hold; no rebind replenishes this unit.
      const extra = adjustment.reviewClaimScopeRepairEarmark;
      check(adjustment.reviewLiteralConditionsRepairEarmark === undefined && previous.profileDigest === s.activeProfileDigest && previous.forward === 21 && adjustment.forward === 22 &&
        previous.monthlyCapYen === 103000 && adjustment.monthlyCapYen === 109000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.reviewPossessionRepairEarmark) === managedDigest(previous.reviewPossessionRepairEarmark) &&
        managedDigest(adjustment.sourceHeatRepairEarmark) === managedDigest(previous.sourceHeatRepairEarmark) &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.reviewClaimScopeRepairEarmark !== undefined && previous.reviewLiteralConditionsRepairEarmark === undefined &&
        adjustment.reviewLiteralConditionsRepairEarmark !== undefined) {
      // One signed literal/condition repair unit. Keep every earlier reservation,
      // including the separate OWNER use; stopped plans cannot replenish it.
      const extra = adjustment.reviewLiteralConditionsRepairEarmark;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 22 && adjustment.forward === 23 &&
        previous.monthlyCapYen === 109000 && adjustment.monthlyCapYen === 114000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.reviewClaimScopeRepairEarmark) === managedDigest(previous.reviewClaimScopeRepairEarmark) &&
        managedDigest(adjustment.reviewPossessionRepairEarmark) === managedDigest(previous.reviewPossessionRepairEarmark) &&
        managedDigest(adjustment.sourceHeatRepairEarmark) === managedDigest(previous.sourceHeatRepairEarmark) &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.reviewLiteralConditionsRepairEarmark !== undefined && previous.reviewEvidenceLocatorsRepairEarmark === undefined &&
        adjustment.reviewEvidenceLocatorsRepairEarmark !== undefined) {
      // One signed evidence-locator repair unit, preserving all earlier holds.
      // Rebinding or stopping cannot add the fixed amounts a second time.
      const extra = adjustment.reviewEvidenceLocatorsRepairEarmark;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 23 && adjustment.forward === 24 &&
        previous.monthlyCapYen === 114000 && adjustment.monthlyCapYen === 119000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.reviewLiteralConditionsRepairEarmark) === managedDigest(previous.reviewLiteralConditionsRepairEarmark) &&
        managedDigest(adjustment.reviewClaimScopeRepairEarmark) === managedDigest(previous.reviewClaimScopeRepairEarmark) &&
        managedDigest(adjustment.reviewPossessionRepairEarmark) === managedDigest(previous.reviewPossessionRepairEarmark) &&
        managedDigest(adjustment.sourceHeatRepairEarmark) === managedDigest(previous.sourceHeatRepairEarmark) &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.reviewEvidenceLocatorsRepairEarmark !== undefined && previous.generationGuardRepairEarmark === undefined &&
        adjustment.generationGuardRepairEarmark !== undefined && adjustment.comparisonDiagnosticsEarmark === undefined) {
      // One signed corrective unit. Earlier reservations and unused OWNER
      // allowance remain intact; rebinding cannot replenish this supplement.
      const extra = adjustment.generationGuardRepairEarmark;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 24 && adjustment.forward === 25 &&
        previous.monthlyCapYen === 119000 && adjustment.monthlyCapYen === 124000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.reviewEvidenceLocatorsRepairEarmark) === managedDigest(previous.reviewEvidenceLocatorsRepairEarmark) &&
        managedDigest(adjustment.reviewLiteralConditionsRepairEarmark) === managedDigest(previous.reviewLiteralConditionsRepairEarmark) &&
        managedDigest(adjustment.reviewClaimScopeRepairEarmark) === managedDigest(previous.reviewClaimScopeRepairEarmark) &&
        managedDigest(adjustment.reviewPossessionRepairEarmark) === managedDigest(previous.reviewPossessionRepairEarmark) &&
        managedDigest(adjustment.sourceHeatRepairEarmark) === managedDigest(previous.sourceHeatRepairEarmark) &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.generationGuardRepairEarmark !== undefined && previous.comparisonDiagnosticsEarmark === undefined &&
        adjustment.comparisonDiagnosticsEarmark !== undefined) {
      // One separately signed diagnostic trial. Preserve the unresolved prior
      // operation and every old hold; this does not issue the conditional trial.
      const extra = adjustment.comparisonDiagnosticsEarmark;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 25 && adjustment.forward === 26 &&
        previous.monthlyCapYen === 124000 && adjustment.monthlyCapYen === 136000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.generationGuardRepairEarmark) === managedDigest(previous.generationGuardRepairEarmark) &&
        managedDigest(adjustment.reviewEvidenceLocatorsRepairEarmark) === managedDigest(previous.reviewEvidenceLocatorsRepairEarmark) &&
        managedDigest(adjustment.reviewLiteralConditionsRepairEarmark) === managedDigest(previous.reviewLiteralConditionsRepairEarmark) &&
        managedDigest(adjustment.reviewClaimScopeRepairEarmark) === managedDigest(previous.reviewClaimScopeRepairEarmark) &&
        managedDigest(adjustment.reviewPossessionRepairEarmark) === managedDigest(previous.reviewPossessionRepairEarmark) &&
        managedDigest(adjustment.sourceHeatRepairEarmark) === managedDigest(previous.sourceHeatRepairEarmark) &&
        managedDigest(adjustment.sourceOutputRepairEarmark) === managedDigest(previous.sourceOutputRepairEarmark) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark) === managedDigest(previous.reviewSourceIdsRepairEarmark) &&
        managedDigest(adjustment.branchRepairEarmark) === managedDigest(previous.branchRepairEarmark) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 525 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.comparisonDiagnosticsEarmark !== undefined && previous.comparisonCorrectiveEarmark === undefined &&
        adjustment.comparisonCorrectiveEarmark !== undefined) {
      // One separately signed conditional corrective unit. Preserve every old
      // reservation and OWNER allowance; no rebind replenishes this addition.
      const extra = adjustment.comparisonCorrectiveEarmark;
      const retained = ["comparisonDiagnosticsEarmark", "generationGuardRepairEarmark", "reviewEvidenceLocatorsRepairEarmark",
        "reviewLiteralConditionsRepairEarmark", "reviewClaimScopeRepairEarmark", "reviewPossessionRepairEarmark",
        "sourceHeatRepairEarmark", "sourceOutputRepairEarmark", "reviewSourceIdsRepairEarmark", "branchRepairEarmark", "executionEarmark"] as const;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 26 &&
        adjustment.forward === 27 && previous.monthlyCapYen === 136000 &&
        adjustment.monthlyCapYen === 136000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        retained.every(key => managedDigest(adjustment[key]) === managedDigest(previous[key])) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 525 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.comparisonAssessmentRepairEarmark !== undefined && previous.sourceActorLocatorRepairEarmark === undefined &&
        adjustment.sourceActorLocatorRepairEarmark !== undefined) {
      // One source-reading repair unit; prior UNKNOWN/OWNER/recovery funds are not released.
      const { sourceActorLocatorRepairEarmark: extra, ...withoutExtra } = adjustment;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 32 && adjustment.forward === 33 &&
        previous.monthlyCapYen === 170000 && adjustment.monthlyCapYen === 176000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest && adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        managedDigest({ ...withoutExtra, profileDigest: previous.profileDigest, ownerApprovalDigest: previous.ownerApprovalDigest,
          repairEpochDigest: previous.repairEpochDigest, monthlyCapYen: previous.monthlyCapYen, forward: previous.forward,
          priorPlanDigest: previous.priorPlanDigest, priorProfileDigest: previous.priorProfileDigest }) === managedDigest(previous) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 525 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        previous.comparisonEvidenceCorrectiveEarmark !== undefined && previous.comparisonAssessmentRepairEarmark === undefined &&
        adjustment.comparisonAssessmentRepairEarmark !== undefined) {
      // One fresh signed successor; preserve every earlier reservation and supplement.
      const { comparisonAssessmentRepairEarmark: extra, ...withoutExtra } = adjustment;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === 31 && adjustment.forward === 32 &&
        previous.monthlyCapYen === 163000 && adjustment.monthlyCapYen === 170000 &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest && adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        managedDigest({ ...withoutExtra, profileDigest: previous.profileDigest, ownerApprovalDigest: previous.ownerApprovalDigest,
          repairEpochDigest: previous.repairEpochDigest, monthlyCapYen: previous.monthlyCapYen, forward: previous.forward,
          priorPlanDigest: previous.priorPlanDigest, priorProfileDigest: previous.priorProfileDigest }) === managedDigest(previous) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 525 }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        adjustment.comparisonAssessmentRepairEarmark === undefined &&
        ((previous.comparisonPromptCorrectiveEarmark !== undefined && previous.comparisonEvidenceRepairEarmark === undefined &&
          adjustment.comparisonEvidenceRepairEarmark !== undefined && adjustment.comparisonEvidenceCorrectiveEarmark === undefined) ||
         (previous.comparisonEvidenceRepairEarmark !== undefined && previous.comparisonEvidenceCorrectiveEarmark === undefined &&
          adjustment.comparisonEvidenceCorrectiveEarmark !== undefined))) {
      // New signed approval is required; an old reservation never funds this unit.
      const corrective = adjustment.comparisonEvidenceCorrectiveEarmark !== undefined;
      const extra = corrective ? adjustment.comparisonEvidenceCorrectiveEarmark! : adjustment.comparisonEvidenceRepairEarmark!;
      const retained = ["comparisonPromptRepairEarmark", "comparisonPromptCorrectiveEarmark", "comparisonCorrectiveEarmark", "comparisonDiagnosticsEarmark", "generationGuardRepairEarmark",
        "reviewEvidenceLocatorsRepairEarmark", "reviewLiteralConditionsRepairEarmark", "reviewClaimScopeRepairEarmark",
        "reviewPossessionRepairEarmark", "sourceHeatRepairEarmark", "sourceOutputRepairEarmark",
        "reviewSourceIdsRepairEarmark", "branchRepairEarmark", "executionEarmark"] as const;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === (corrective ? 30 : 29) &&
        adjustment.forward === (corrective ? 31 : 30) && previous.monthlyCapYen === (corrective ? 157000 : 148000) &&
        adjustment.monthlyCapYen === (corrective ? 163000 : 157000) &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        retained.every(key => managedDigest(adjustment[key]) === managedDigest(previous[key])) &&
        (!corrective || managedDigest(adjustment.comparisonEvidenceRepairEarmark) === managedDigest(previous.comparisonEvidenceRepairEarmark)) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + (corrective ? 525 : 1050) }));
    } else if (previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        ((previous.comparisonCorrectiveEarmark !== undefined && previous.comparisonPromptRepairEarmark === undefined &&
          adjustment.comparisonPromptRepairEarmark !== undefined && adjustment.comparisonPromptCorrectiveEarmark === undefined) ||
         (previous.comparisonPromptRepairEarmark !== undefined && previous.comparisonPromptCorrectiveEarmark === undefined &&
          adjustment.comparisonPromptCorrectiveEarmark !== undefined))) {
      // New signed approval is required; an old reservation never funds this unit.
      const corrective = adjustment.comparisonPromptCorrectiveEarmark !== undefined;
      const extra = corrective ? adjustment.comparisonPromptCorrectiveEarmark! : adjustment.comparisonPromptRepairEarmark!;
      const retained = ["comparisonCorrectiveEarmark", "comparisonDiagnosticsEarmark", "generationGuardRepairEarmark",
        "reviewEvidenceLocatorsRepairEarmark", "reviewLiteralConditionsRepairEarmark", "reviewClaimScopeRepairEarmark",
        "reviewPossessionRepairEarmark", "sourceHeatRepairEarmark", "sourceOutputRepairEarmark",
        "reviewSourceIdsRepairEarmark", "branchRepairEarmark", "executionEarmark"] as const;
      check(previous.profileDigest === s.activeProfileDigest && previous.forward === (corrective ? 28 : 27) &&
        adjustment.forward === (corrective ? 29 : 28) && previous.monthlyCapYen === (corrective ? 142000 : 136000) &&
        adjustment.monthlyCapYen === (corrective ? 148000 : 142000) &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        retained.every(key => managedDigest(adjustment[key]) === managedDigest(previous[key])) &&
        (!corrective || managedDigest(adjustment.comparisonPromptRepairEarmark) === managedDigest(previous.comparisonPromptRepairEarmark)) &&
        input.baseYen === old.baseYen + extra.aiYen + extra.imageRetentionYen + extra.nonAiYen + extra.storageYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 525 }));
    } else {
      check(previous?.scope === "ISSUE150_PRACTITIONER_EVALUATION_V1" &&
        input.baseYen === old.baseYen && managedDigest(input.pools) === managedDigest(old.pools) &&
        adjustment.ownerApprovalDigest === previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest === previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        adjustment.monthlyCapYen === previous.monthlyCapYen &&
        managedDigest(adjustment.comparisonEvidenceRepairEarmark ?? null) === managedDigest(previous.comparisonEvidenceRepairEarmark ?? null) &&
        managedDigest(adjustment.comparisonEvidenceCorrectiveEarmark ?? null) === managedDigest(previous.comparisonEvidenceCorrectiveEarmark ?? null) &&
        managedDigest(adjustment.comparisonAssessmentRepairEarmark ?? null) === managedDigest(previous.comparisonAssessmentRepairEarmark ?? null) &&
        managedDigest(adjustment.sourceActorLocatorRepairEarmark ?? null) === managedDigest(previous.sourceActorLocatorRepairEarmark ?? null) &&
        managedDigest(adjustment.comparisonPromptRepairEarmark ?? null) === managedDigest(previous.comparisonPromptRepairEarmark ?? null) &&
        managedDigest(adjustment.comparisonPromptCorrectiveEarmark ?? null) === managedDigest(previous.comparisonPromptCorrectiveEarmark ?? null) &&
        managedDigest(adjustment.comparisonCorrectiveEarmark ?? null) === managedDigest(previous.comparisonCorrectiveEarmark ?? null) &&
        managedDigest(adjustment.comparisonDiagnosticsEarmark ?? null) === managedDigest(previous.comparisonDiagnosticsEarmark ?? null) &&
        managedDigest(adjustment.generationGuardRepairEarmark ?? null) === managedDigest(previous.generationGuardRepairEarmark ?? null) &&
        managedDigest(adjustment.reviewEvidenceLocatorsRepairEarmark ?? null) === managedDigest(previous.reviewEvidenceLocatorsRepairEarmark ?? null) &&
        managedDigest(adjustment.reviewLiteralConditionsRepairEarmark ?? null) === managedDigest(previous.reviewLiteralConditionsRepairEarmark ?? null) &&
        managedDigest(adjustment.reviewClaimScopeRepairEarmark ?? null) === managedDigest(previous.reviewClaimScopeRepairEarmark ?? null) &&
        managedDigest(adjustment.reviewPossessionRepairEarmark ?? null) === managedDigest(previous.reviewPossessionRepairEarmark ?? null) &&
        managedDigest(adjustment.sourceHeatRepairEarmark ?? null) === managedDigest(previous.sourceHeatRepairEarmark ?? null) &&
        managedDigest(adjustment.sourceOutputRepairEarmark ?? null) === managedDigest(previous.sourceOutputRepairEarmark ?? null) &&
        managedDigest(adjustment.reviewSourceIdsRepairEarmark ?? null) === managedDigest(previous.reviewSourceIdsRepairEarmark ?? null) &&
        managedDigest(adjustment.branchRepairEarmark ?? null) === managedDigest(previous.branchRepairEarmark ?? null) &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark));
    }
  } else if (input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1" ||
      old?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1") {
    const adjustment = input.standardMonthAdjustment, previous = old?.standardMonthAdjustment;
    check(adjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1" &&
      old !== undefined && managedDigest(old) === adjustment.priorPlanDigest &&
      adjustment.priorProfileDigest === s.activeProfileDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0);
    const { reviewScopeRepairProductionAiYen, reviewScopeRepairImageRetentionYen, ...priorEarmark } = adjustment.executionEarmark;
    if (previous?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1") {
      // Keep every prior hold and add only this trial's AI/image reservation
      // and the bounded shortfall in the existing release pool. A fresh signed
      // owner/epoch binds its own finite deadline; later updates cannot extend it.
      check(previous.profileDigest === s.activeProfileDigest &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        managedDigest(priorEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + reviewScopeRepairProductionAiYen + reviewScopeRepairImageRetentionYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 535 }));
    } else {
      check(previous?.scope === "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1" &&
        input.baseYen === old.baseYen && managedDigest(input.pools) === managedDigest(old.pools) &&
        adjustment.ownerApprovalDigest === previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest === previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark));
    }
  } else if (input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1" ||
      old?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1") {
    const adjustment = input.standardMonthAdjustment, previous = old?.standardMonthAdjustment;
    check(adjustment?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1" &&
      old !== undefined && managedDigest(old) === adjustment.priorPlanDigest &&
      adjustment.priorProfileDigest === s.activeProfileDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0);
    const { bindingRepairProductionAiYen, bindingRepairImageRetentionYen, ...priorEarmark } = adjustment.executionEarmark;
    if (previous?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1") {
      // Keep every prior hold and add only this trial's AI/image reservation
      // and the bounded shortfall in the existing release pool.
      check(previous.profileDigest === s.activeProfileDigest &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        Date.parse(adjustment.validUntil) <= Date.parse(previous.validUntil) &&
        managedDigest(priorEarmark) === managedDigest(previous.executionEarmark) &&
        input.baseYen === old.baseYen + bindingRepairProductionAiYen + bindingRepairImageRetentionYen &&
        managedDigest(input.pools) === managedDigest({ ...old.pools, remaining: old.pools.remaining + 389 }));
    } else {
      check(previous?.scope === "ISSUE150_NOVEMBER_BINDING_REPAIR_V1" &&
        input.baseYen === old.baseYen && managedDigest(input.pools) === managedDigest(old.pools) &&
        adjustment.ownerApprovalDigest === previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest === previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark));
    }
  } else if (input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1" ||
      old?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1") {
    // Carry existing reservations, including an uncertain release, without
    // adding another AI/image earmark. The signed review binds the whole state.
    const adjustment = input.standardMonthAdjustment, previous = old?.standardMonthAdjustment;
    check(adjustment?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1" &&
      old !== undefined && managedDigest(old) === adjustment.priorPlanDigest &&
      adjustment.priorProfileDigest === s.activeProfileDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0 &&
      input.baseYen === old.baseYen && managedDigest(input.pools) === managedDigest(old.pools));
    check((previous?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1" ||
      previous?.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1") &&
      managedDigest(adjustment.executionEarmark) === managedDigest(previous.executionEarmark));
    if (previous.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1") {
      check(previous.profileDigest === s.activeProfileDigest &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        Date.parse(adjustment.validUntil) <= Date.parse(previous.validUntil));
    } else {
      check(previous.scope === "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1" &&
        adjustment.ownerApprovalDigest === previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest === previous.repairEpochDigest && adjustment.validUntil === previous.validUntil);
    }
  } else if (input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1" ||
      old?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1") {
    const adjustment = input.standardMonthAdjustment, previous = old?.standardMonthAdjustment;
    check(adjustment?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1" &&
      old !== undefined && managedDigest(old) === adjustment.priorPlanDigest &&
      adjustment.priorProfileDigest === s.activeProfileDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0 &&
      managedDigest(input.pools) === managedDigest(old.pools));
    const earmark = adjustment.executionEarmark;
    const { reservationRepairProductionAiYen, reservationRepairImageRetentionYen, ...priorEarmark } = earmark;
    check(input.baseYen === earmark.forecastBaseYen + earmark.productionAiYen + earmark.imageRetentionYen +
      earmark.additionalProductionAiYen + earmark.additionalImageRetentionYen +
      reservationRepairProductionAiYen + reservationRepairImageRetentionYen);
    if (previous?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1") {
      check(previous.profileDigest === s.activeProfileDigest &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        Date.parse(adjustment.validUntil) <= Date.parse(previous.validUntil) &&
        input.baseYen === old.baseYen + 2353 && managedDigest(priorEarmark) === managedDigest(previous.executionEarmark));
    } else {
      check(previous?.scope === "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1" &&
        input.baseYen === old.baseYen && adjustment.monthlyCapYen === previous.monthlyCapYen &&
        adjustment.ownerApprovalDigest === previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest === previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(earmark) === managedDigest(previous.executionEarmark));
    }
  } else if (input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1" ||
      old?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1") {
    const adjustment = input.standardMonthAdjustment, previous = old?.standardMonthAdjustment;
    check(adjustment?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1" &&
      old !== undefined && managedDigest(old) === adjustment.priorPlanDigest &&
      adjustment.priorProfileDigest === s.activeProfileDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0 &&
      managedDigest(input.pools) === managedDigest(old.pools));
    const earmark = adjustment.executionEarmark;
    check(input.baseYen === earmark.forecastBaseYen + earmark.productionAiYen + earmark.imageRetentionYen +
      earmark.additionalProductionAiYen + earmark.additionalImageRetentionYen);
    if (previous?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1") {
      // One new finite approval adds only the new AI/image hold. The prior
      // failed trial and every unresolved operation retain their whole costs.
      check(previous.profileDigest === s.activeProfileDigest &&
        adjustment.ownerApprovalDigest !== previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest !== previous.repairEpochDigest &&
        input.baseYen === old.baseYen + 2353 &&
        managedDigest({ forecastBaseYen: earmark.forecastBaseYen, productionAiYen: earmark.productionAiYen,
          imageRetentionYen: earmark.imageRetentionYen }) === managedDigest(previous.executionEarmark));
    } else {
      check(previous?.scope === "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1" &&
        input.baseYen === old.baseYen && adjustment.monthlyCapYen === previous.monthlyCapYen &&
        adjustment.ownerApprovalDigest === previous.ownerApprovalDigest &&
        adjustment.repairEpochDigest === previous.repairEpochDigest && adjustment.validUntil === previous.validUntil &&
        managedDigest(earmark) === managedDigest(previous.executionEarmark));
    }
  } else if (input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1" ||
    old?.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1") {
    check(input.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1");
    // Rollover carries every unresolved operation. Only the unreserved October
    // pools become November plans. The fixed AI/image hold moves from unused
    // remaining funds into base, without replenishing units or raising forecast.
    const prior = old ?? s.plans.find(p => p.month === "2026-10");
    check(prior !== undefined && managedDigest(prior) === input.standardMonthAdjustment.priorPlanDigest);
    check(input.completionAllowance === undefined && input.releaseMonthlyCapYen === undefined &&
      input.releaseTailYen === s.releaseTailYen && (input.reviewedOperationIds?.length ?? 0) === 0);
    const earmark = input.standardMonthAdjustment.executionEarmark;
    const held = earmark.productionAiYen + earmark.imageRetentionYen;
    check(input.baseYen === earmark.forecastBaseYen + held);
    if (old) {
      check(old.standardMonthAdjustment?.scope === "ISSUE150_NOVEMBER_REPAIR_MONTH_V1" &&
        input.baseYen === old.baseYen && managedDigest(input.pools) === managedDigest(old.pools) &&
        input.standardMonthAdjustment.monthlyCapYen === old.standardMonthAdjustment.monthlyCapYen &&
        managedDigest(earmark) === managedDigest(old.standardMonthAdjustment.executionEarmark));
    } else {
      check(prior.standardMonthAdjustment?.scope === "ISSUE150_STANDARD_MONTH_V1" ||
        prior.standardMonthAdjustment?.scope === "ISSUE150_REPAIR_STANDARD_MONTH_V1");
      check(earmark.forecastBaseYen >= prior.baseYen);
      for (const pool of poolKeys) check(input.pools[pool] ===
        prior.pools[pool] - poolUsed(s, prior.month, pool) - (pool === "remaining" ? held : 0));
    }
  }
  const plan = planSchema.parse({ month: m, baseYen: input.baseYen, pools: input.pools, pricingDigest: input.pricingDigest,
    ...(input.releaseMonthlyCapYen === undefined ? {} : { releaseMonthlyCapYen: input.releaseMonthlyCapYen }),
    ...(input.completionAllowance === undefined ? {} : { completionAllowance: input.completionAllowance }),
    ...(input.standardMonthAdjustment === undefined ? {} : { standardMonthAdjustment: input.standardMonthAdjustment }),
    evidenceDigests: [...new Set([...(old?.evidenceDigests ?? []), hash.parse(input.evidenceDigest)])] });
  if (old) s.plans[s.plans.indexOf(old)] = plan; else s.plans.push(plan);
  s.releaseTailYen = yen.parse(input.releaseTailYen);
  for (const id of input.reviewedOperationIds ?? []) { const o = find(s, z.uuidv4().parse(id)); evidence(o, input.evidenceDigest); o.reviewRequired = false; }
  for (const pool of poolKeys) check(poolUsed(s, m, pool) <= plan.pools[pool]);
  return seal(s); // An over-cap plan is recorded, never a permission to start.
}
export function activateManagedBudgetProfile(value: unknown, profile: unknown, checkedEvidence: {
  profileDigest: string; goEvidenceDigest: string; measurementDigest: string; pricingDigest: string;
}, clock: ManagedBudgetClock) {
  const { s, month: m } = current(value, clock), p = managedBudgetProfileSchema.parse(profile);
  check(p.targetBindingHash === s.targetBindingHash && managedDigest(p) === checkedEvidence.profileDigest &&
    p.goEvidenceDigest === checkedEvidence.goEvidenceDigest && p.measurementDigest === checkedEvidence.measurementDigest && p.pricingDigest === checkedEvidence.pricingDigest);
  s.cases = [...new Set([...s.cases, ...p.cases])].sort((a, b) => a - b);
  s.activeProfileDigest = managedDigest(p); active(s, p); admit(s, m, p, clock.maximumActionMs);
  return seal(s);
}
export function reserveManagedBudget(value: unknown, request: unknown, profile: unknown, clock: ManagedBudgetClock) {
  const { s, ms, month: m, end } = current(value, clock), r = managedBudgetRequestSchema.parse(request);
  r.cases.sort((a, b) => a - b);
  const previous = s.operations.find(o => o.operationId === r.operationId || o.requestDigest === r.requestDigest);
  if (previous) { check(previous.operationId === r.operationId && previous.intentDigest === managedDigest(r)); return { state: s, created: false }; }
  // Reserve space for every operation's bounded final evidence, not only today's
  // small unclosed row. Existing rows are never deleted to obtain another slot.
  check((s.operations.length + 1) * 20 * 1024 + 1024 ** 2 <= 16 * 1024 ** 2 && ms + clock.maximumActionMs < end);
  const p = r.scope === "standard" ? active(s, profile) : undefined;
  if (p) check(r.profileDigest === managedDigest(p) && r.pricingDigest === p.pricingDigest && r.cases.every(id => p.cases.includes(id)));
  else check(r.profileDigest === null);
  s.cases = [...new Set([...s.cases, ...r.cases])].sort((a, b) => a - b);
  const plan = s.plans.find(p => p.month === m), pool = poolOf(r); check(plan);
  check(r.pricingDigest === plan.pricingDigest);
  check(poolUsed(s, m, pool) + r.reservationYen <= plan.pools[pool]);
  if (r.scope === "release") { check(s.releaseTailYen >= r.reservationYen); s.releaseTailYen -= r.reservationYen; }
  s.operations.push({ ...r, intentDigest: managedDigest(r), processingMonth: m, reservedAt: s.lastTrustedAt,
    expiresAt: new Date(Math.min(ms + 6 * 60 * 60_000, end)).toISOString(), stage: r.kind === "import" ? "ready" : "unused",
    start: "ready", unknown: false, actualYen: null, observedYen: null, reviewRequired: false, knownUnits: {}, evidenceDigests: [],
    evidenceChainDigest: managedDigest(r), lastProofSequence: 0, settlements: [] });
  admit(s, m, p, clock.maximumActionMs); return { state: seal(s), created: true };
}
export function claimManagedBudgetPhase(value: unknown, id: string, phase: "stage" | "start", profile: unknown, clock: ManagedBudgetClock) {
  const { s, ms, month: m, end } = current(value, clock), o = find(s, id);
  check(!o.unknown && o.actualYen === null && o.processingMonth === m && ms + clock.maximumActionMs < Math.min(end, Date.parse(o.expiresAt)));
  check(o.pricingDigest === s.plans.find(p => p.month === m)?.pricingDigest);
  const p = o.scope === "standard" ? active(s, profile) : undefined;
  if (p) check(o.profileDigest === managedDigest(p));
  admit(s, m, p, clock.maximumActionMs);
  if (phase === "stage") { check(o.kind === "import" && o.stage === "ready"); o.stage = "claimed"; }
  else { check(o.start === "ready" && (o.stage === "unused" || o.stage === "done")); o.start = "claimed"; }
  return seal(s);
}
export function confirmManagedBudgetStage(value: unknown, id: string, requestDigest: string, stageDigest: string, clock: ManagedBudgetClock) {
  const { s } = current(value, clock), o = find(s, id);
  check(o.requestDigest === requestDigest && o.stage === "claimed" && o.start === "ready");
  o.stage = "done"; o.stageDigest = hash.parse(stageDigest); o.unknown = false; evidence(o, stageDigest); return seal(s);
}
export function markManagedBudgetUnknown(value: unknown, id: string, clock: ManagedBudgetClock) {
  const { s } = current(value, clock), o = find(s, id); if (!closed(o)) o.unknown = true; return seal(s);
}
export function settleManagedBudget(value: unknown, proof: { operationId: string; requestDigest: string; sequence: number; evidenceDigest: string;
  knownUnits: Partial<ManagedBudgetUnits>; observedYen?: number; actualYen?: number }, clock: ManagedBudgetClock) {
  const { s } = current(value, clock), o = find(s, proof.operationId); check(o.requestDigest === proof.requestDigest);
  const known = managedBudgetUnitsSchema.partial().strict().parse(proof.knownUnits);
  const sequence = quantity.refine(v => v > 0).parse(proof.sequence);
  const proofDigest = managedDigest({ operationId: o.operationId, requestDigest: o.requestDigest, sequence,
    evidenceDigest: hash.parse(proof.evidenceDigest), knownUnits: known,
    ...(proof.actualYen === undefined ? {} : { actualYen: yen.parse(proof.actualYen) }),
    ...(proof.observedYen === undefined ? {} : { observedYen: yen.parse(proof.observedYen) }) });
  const previous = o.settlements.find(p => p.evidenceDigest === proof.evidenceDigest);
  if (previous) {
    check(previous.proofDigest === proofDigest);
    return seal(managedBudgetStateSchema.parse(value));
  }
  // Older compacted proofs require adapter read-back of the immutable sequence
  // slot. A hash chain alone is not evidence that an arbitrary proof was applied.
  check(sequence === o.lastProofSequence + 1);
  check(!o.evidenceDigests.includes(proof.evidenceDigest));
  for (const k of unitKeys) if (known[k] !== undefined) {
    check(o.knownUnits[k] === undefined || known[k]! >= o.knownUnits[k]!);
    if (known[k]! > o.units[k] || (o.knownUnits[k] !== undefined && known[k]! > o.knownUnits[k]!)) o.reviewRequired = true;
    o.knownUnits[k] = known[k];
  }
  if (proof.observedYen !== undefined) {
    const amount = yen.parse(proof.observedYen); check(amount >= (o.observedYen ?? 0));
    if (amount > cost(o)) o.reviewRequired = true;
    o.observedYen = amount;
  }
  if (proof.actualYen !== undefined) {
    const actual = yen.parse(proof.actualYen); check(unitKeys.every(k => o.knownUnits[k] !== undefined));
    check(actual >= (o.actualYen ?? 0) && actual >= (o.observedYen ?? 0));
    if (actual > o.reservationYen || (o.actualYen !== null && actual > o.actualYen)) o.reviewRequired = true;
    if (o.actualYen === null && o.scope === "release" && actual < o.reservationYen) s.releaseTailYen += o.reservationYen - actual;
    o.actualYen = actual;
  }
  evidence(o, proof.evidenceDigest); o.lastProofSequence = sequence;
  o.settlements = [...o.settlements, { sequence, evidenceDigest: proof.evidenceDigest, proofDigest }].slice(-64);
  o.unknown = !closed(o);
  return seal(s); // Overrun is evidence, not grounds to discard the observed bill.
}
