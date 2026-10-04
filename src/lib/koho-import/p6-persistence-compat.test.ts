import { describe, expect, it } from "vitest";
import { parseKohoPackage, type KohoPackageCountSummary } from "../koho-package";
import { buildMinimalFictionalPackage, FICTIONAL_PACKAGE_LIMITS } from "../koho-package/__fixtures__/fictional-package";
import { buildKohoImportPlan } from "./builder";
import { assertKohoImportPlan, serializeKohoImportCountsJson } from "./persistence-contract";

async function legacyPlan() {
  const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes: buildMinimalFictionalPackage("JPA") }, limits: FICTIONAL_PACKAGE_LIMITS });
  return buildKohoImportPlan({ packageResult: parsed, sourceSha256: "1".repeat(64) });
}
function withCorrection(counts: KohoPackageCountSummary): KohoPackageCountSummary {
  return { ...counts, primaryXmlCandidates: counts.primaryXmlCandidates + 1, finalXmlResults: counts.finalXmlResults + 1,
    documentFolders: counts.documentFolders + 1, documentListRecords: counts.documentListRecords + 1,
    bySection: { ...counts.bySection, P_P6: { ...counts.bySection.P_P5, primaryXmlCandidates: 1, finalXmlResults: 1,
      documentFolders: 1, contents1Records: 1, confirmedCorrections: 1 } }, confirmedCorrections: 1 };
}
describe("P6 persisted counts compatibility", () => {
  it("preserves the exact five-section historical canonical JSON", async () => {
    const plan = await legacyPlan(), before = JSON.stringify(plan);
    expect(JSON.parse(plan.countsJson).bySection).not.toHaveProperty("P_P6");
    expect(JSON.parse(plan.countsJson)).not.toHaveProperty("confirmedCorrections");
    expect(serializeKohoImportCountsJson(JSON.parse(plan.countsJson))).toBe(plan.countsJson);
    assertKohoImportPlan(plan);
    expect(JSON.stringify(plan)).toBe(before);
  });
  it("adds corrections without increasing ordinary documents or amendments", async () => {
    const plan = await legacyPlan(), originalDocuments = structuredClone(plan.documents), originalAmendments = plan.amendmentCount;
    const counts = withCorrection(JSON.parse(plan.countsJson));
    plan.countsJson = serializeKohoImportCountsJson(counts);
    assertKohoImportPlan(plan);
    expect(plan.documents).toEqual(originalDocuments);
    expect(plan.documentCount).toBe(originalDocuments.length);
    expect(plan.amendmentCount).toBe(originalAmendments);
    expect(JSON.parse(plan.countsJson)).toMatchObject({ confirmedCorrections: 1, bySection: { P_P6: { confirmedCorrections: 1 } } });
  });
  it.each(["top", "section", "amendment", "full", "unknown", "negative"])("rejects a corrupted P6 count contract: %s", async mutation => {
    const counts = withCorrection(JSON.parse((await legacyPlan()).countsJson));
    if (mutation === "top") delete counts.confirmedCorrections;
    if (mutation === "section") delete counts.bySection.P_P6;
    if (mutation === "amendment") counts.bySection.P_P6!.confirmedAmendments = 1;
    if (mutation === "full") counts.bySection.P_P6!.confirmedFullPublications = 1;
    if (mutation === "unknown") Object.assign(counts.bySection, { P_P7: counts.bySection.P_P6 });
    if (mutation === "negative") counts.confirmedCorrections = -1;
    expect(() => serializeKohoImportCountsJson(counts)).toThrow("invalid_counts_json");
  });
});
