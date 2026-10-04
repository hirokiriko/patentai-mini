import { describe, expect, it } from "vitest";
import { parseKohoPackage } from "./orchestrator";
import { buildZip } from "../koho-zip/__fixtures__/zip-builder";
import { buildFictionalCorrectionXml, fictionalPrimaryEntryPath } from "../koho-xml/__fixtures__/fictional-koho";
import { buildManagedImportLimits } from "../koho-import/managed-limits";
import { buildKohoImportPlan } from "../koho-import/builder";
import { projectManagedPackageReceipt } from "../koho-import/managed-package-receipt";

async function parse(list = "JP,2099000007,A6,20990216\r\n", count = 1) {
  const label = "訂正(公表特許公報)(P_P6)";
  const width = Array.from(label).reduce((sum, c) => sum + (c.codePointAt(0)! <= 127 ? 1 : 2), 0);
  const bytes = buildZip({ entries: [
    { fileName: "ABSTRACT.csv", data: `A_001,20990216,2099-016,09999\r\n${label}${" ".repeat(80 - width)},FICTIONAL-RANGE,${String(count).padStart(5, "0")}\r\n` },
    { fileName: "DOCUMENT_LIST.csv", data: list },
    { fileName: fictionalPrimaryEntryPath("P6"), data: buildFictionalCorrectionXml() },
  ] }).bytes;
  return parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes }, limits: buildManagedImportLimits(bytes.length) });
}

describe("P6 package reconciliation", () => {
  it("counts a correction once without creating a document or an amendment", async () => {
    const result = await parse();
    expect(result.status).toBe("success");
    expect(result.counts).toMatchObject({ primaryXmlCandidates: 1, finalXmlResults: 1,
      documentListRecords: 1, confirmedFullPublications: 0, confirmedAmendments: 0, confirmedCorrections: 1 });
    expect(result.counts.bySection.P_P6).toMatchObject({ primaryXmlCandidates: 1, finalXmlResults: 1,
      confirmedFullPublications: 0, confirmedAmendments: 0, confirmedCorrections: 1 });
    const plan = buildKohoImportPlan({ packageResult: result, sourceSha256: "f".repeat(64) });
    expect(plan.documentCount).toBe(0);
    expect(plan.amendmentCount).toBe(0);
    expect(projectManagedPackageReceipt(result, plan)).toMatchObject({ schema: 1, documentCount: 0,
      amendmentCount: 0, translatedCorrections: 1, corrections: [{ kind: "P6", claimsEffect: "unresolved" }] });
    expect(result.issues.map(i => i.code)).not.toContain("unclassified_xml_entry");
    expect(result.issues.map(i => i.code)).not.toContain("document_list_orphan");
  });

  it.each([
    ["JP,2099000007,A6,20990216\r\nJP,2099000007,A6,20990216\r\n", "document_list_match_ambiguous"],
    ["JP,2099000999,A6,20990216\r\n", "document_list_match_missing"],
    ["JP,2099000007,A5,20990216\r\n", "primary_xml_unconfirmed"],
    ["JP,2099000007,A6,20990217\r\n", "primary_xml_unconfirmed"],
    ["US,2099000007,A6,20990216\r\n", "document_list_match_ambiguous"],
    ["WO,2099000007,A6,20990216\r\n", "document_list_match_ambiguous"],
  ])("does not accept conflicting or ambiguous list evidence", async (list, code) => {
    const result = await parse(list);
    expect(result.counts.confirmedCorrections).toBe(0);
    expect(result.issues.map(i => i.code)).toContain(code);
    const plan = buildKohoImportPlan({ packageResult: result, sourceSha256: "f".repeat(64) });
    expect(() => projectManagedPackageReceipt(result, plan)).toThrow();
  });

  it("retains a missing correction as a count mismatch instead of waiving the official count", async () => {
    const result = await parse(undefined, 2);
    expect(result.issues.map(i => i.code)).toContain("abstract_count_mismatch");
    const plan = buildKohoImportPlan({ packageResult: result, sourceSha256: "f".repeat(64) });
    expect(() => projectManagedPackageReceipt(result, plan)).toThrow();
  });
});
