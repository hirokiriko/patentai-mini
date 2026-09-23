import type { ManagedDelivery } from "./managed-delivery";
export function managedDeliveryFixture(count = 1, complete = true): ManagedDelivery {
  return { schema: 1, deliveryId: "12345678-1234-4234-8234-123456789012", caseId: 7, version: 1, previousDeliveryId: null, reason: "initial",
    period: { from: "2026-07-26", to: "2026-08-25" }, generatedAt: "2026-08-26T00:00:00.000Z", deliveryDueOn: "2026-08-31", deliveredOn: null,
    contractSignedOn: "2026-07-24", monitoringStartsOn: "2026-07-26", contractEndsOn: null,
    base: { publicationNumber: "JP-FICTIONAL-BASE", version: "A1", selectedClaimNos: [1] },
    coverage: { expectedPackages: 21, availablePackages: complete ? 21 : 20, importedDocuments: 200, incompleteDocuments: 0, observedCorrections: 0, unresolvedCorrections: 0,
      prefiltered: 100, compared: count, completedRuns: complete ? 2 : 0, failedRuns: complete ? 0 : 1, activeRuns: 0,
      acquiredAt: "2026-08-25T10:00:00.000Z", comparedAt: complete ? "2026-08-26T00:00:00.000Z" : null, complete },
    findings: Array.from({ length: count }, (_, i) => ({ findingId: i + 1, publicationNumber: `JP-FICTIONAL-${i + 1}`, publicationDate: "2026-08-12",
      inventionTitle: "完全架空の月面検出装置", detectedAt: "2026-08-25T23:00:00.000Z", reviewStatus: i % 2 ? "reviewed" : "unreviewed", relation: "unknown",
      comparisons: [{ baseClaimNo: 1, candidateClaimNo: 2, baseEvidence: { claimNo: 1, start: 2010, end: 2020 }, candidateEvidence: { claimNo: 2, start: 4050, end: 4060 },
        lexicalScore: 0.5, elementScore: 0.4, semanticScore: 0.3, structuralScore: 0.2, riskLabel: "Medium", explanation: "架空の比較説明。指定位置と原文の確認が必要です。" }] })) };
}
