import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { manualFixture } from "../../../scripts/koho-manual-import-fixtures";
import { parseKohoPackage } from "../koho-package";
import { buildKohoManualImportLimits } from "./manual-api";
import { buildKohoImportPlan } from "./builder";
import { managedPackageReceiptSchema, projectManagedPackageReceipt, validateManagedPackageReceipt } from "./managed-package-receipt";
import { managedDigest } from "../patent-watch/managed-claims";
import { fictionalP6Package } from "./p6-package.test-support";
describe("immutable package receipt", () => {
  it.each([false, true])("ties issue/date/control/counts and separates amendments (%s)", async amendment => {
    const bytes = manualFixture("JPA", 1, { publicationDate: "2026-08-12", issue: "2026-148", control: "01115", amendment });
    const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: createHash("sha256").update(bytes).digest("hex") });
    const receipt = projectManagedPackageReceipt(parsed, plan);
    const serialized = JSON.stringify(receipt);
    expect(receipt).not.toHaveProperty("translatedCorrections");
    expect(JSON.stringify(managedPackageReceiptSchema.parse(receipt))).toBe(serialized);
    expect(managedDigest(managedPackageReceiptSchema.parse(receipt))).toBe(managedDigest(receipt));
    expect(receipt).toMatchObject({ publicationDate: "2026-08-12", issueNumber: "2026-148", cumulativeIssue: "01115", publishedCount: 1,
      translatedCount: 0, documentCount: 1, publishedAmendments: amendment ? 1 : 0, amendmentCount: amendment ? 1 : 0 });
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, publishedCount: 2 })).toThrow("incomplete");
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, sourceSha256: "f".repeat(64) })).toThrow("incomplete");
  });
  it.each(["xml", "image", "none"] as const)("keeps a P6 %s correction separate from ordinary documents and amendments", async payload => {
    const bytes = fictionalP6Package({ payload });
    const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: createHash("sha256").update(bytes).digest("hex") });
    const receipt = projectManagedPackageReceipt(parsed, plan);
    expect(plan.documentCount).toBe(1);
    expect(plan.amendmentCount).toBe(0);
    expect(receipt).toMatchObject({ schema: 1, publishedCount: 1, translatedCount: 0, publishedAmendments: 0,
      translatedAmendments: 0, translatedCorrections: 1, amendmentCount: 0, documentCount: 1 });
    expect(receipt.corrections).toHaveLength(1);
    expect(receipt.corrections[0]).toMatchObject({ kind: "P6", originalPublicationNumber: "2099000007", originalPublicationDate: "2026-08-11", claimsEffect: "unresolved", changes: [] });
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, translatedCorrections: 0 })).toThrow();
    const { translatedCorrections, ...missing } = receipt; void translatedCorrections;
    expect(() => validateManagedPackageReceipt(plan, missing)).toThrow();
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, translatedAmendments: 1 })).toThrow();
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, corrections: receipt.corrections.map(c => ({ ...c, claimsEffect: "none" })) })).toThrow();
  });
});
