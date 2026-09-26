import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { manualFixture } from "../../../scripts/koho-manual-import-fixtures";
import { parseKohoPackage } from "../koho-package";
import { buildKohoManualImportLimits } from "./manual-api";
import { buildKohoImportPlan } from "./builder";
import { projectManagedPackageReceipt, validateManagedPackageReceipt } from "./managed-package-receipt";
describe("immutable package receipt", () => {
  it.each([false, true])("ties issue/date/control/counts and separates amendments (%s)", async amendment => {
    const bytes = manualFixture("JPA", 1, { publicationDate: "2026-08-12", issue: "2026-148", control: "01115", amendment });
    const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildKohoManualImportLimits(bytes.length) });
    const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: createHash("sha256").update(bytes).digest("hex") });
    const receipt = projectManagedPackageReceipt(parsed, plan);
    expect(receipt).toMatchObject({ publicationDate: "2026-08-12", issueNumber: "2026-148", cumulativeIssue: "01115", publishedCount: 1,
      translatedCount: 0, documentCount: 1, publishedAmendments: amendment ? 1 : 0, amendmentCount: amendment ? 1 : 0 });
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, publishedCount: 2 })).toThrow("incomplete");
    expect(() => validateManagedPackageReceipt(plan, { ...receipt, sourceSha256: "f".repeat(64) })).toThrow("incomplete");
  });
});
