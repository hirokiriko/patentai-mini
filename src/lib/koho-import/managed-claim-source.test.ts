import { describe, expect, it } from "vitest";
import { parseKohoXml } from "../koho-xml";
import { buildFictionalFullPublicationXml, createFictionalKohoInput } from "../koho-xml/__fixtures__/fictional-koho";
import { managedClaimReferences, projectManagedClaimSource } from "./managed-claim-source";
import type { KohoImportDocumentPlan } from "./types";
function fixture() {
  const parsed = parseKohoXml(createFictionalKohoInput("A1", { xml: buildFictionalFullPublicationXml("A1", {
    claims: [{ number: "1", text: "架空の検出装置。".repeat(400) + "全文の末尾制約。" }, { number: "2", text: "請求項１に記載の装置。" }],
  }) }));
  if (!("document" in parsed) || !parsed.document) throw Error("fixture_parse_failed");
  const document = parsed.document;
  const stored = { normalizedEntryPath: document.source.normalizedEntryPath, publicationNumber: document.publicationNumber.value,
    kind: document.kind, contentSha256: "a".repeat(64), claimsText: document.claims.map(c => c.plainText).join("\n\n") } as KohoImportDocumentPlan;
  return { document, stored };
}
describe("original parser to managed claim metadata", () => {
  it("preserves original numbers and complete text after 2,000 characters", () => {
    const f = fixture(), projected = projectManagedClaimSource(f.document, f.stored, "b".repeat(64));
    expect(projected.status).toBe("complete");
    const source = JSON.parse(projected.claimsJson!);
    expect(source.claims.map((c: { claimNo: number }) => c.claimNo)).toEqual([1, 2]);
    expect(source.claims[1].dependsOn).toEqual([1]);
    expect(source.claims.map((c: { text: string }) => c.text).join("\n\n")).toBe(f.stored.claimsText);
    expect(source.claims[0].text.endsWith("全文の末尾制約。")).toBe(true);
  });
  it("detects number-only revisions without altering old content identity", () => {
    const f = fixture(), before = projectManagedClaimSource(f.document, f.stored, "b".repeat(64));
    f.document.claims[1].claimNumber = "3";
    const after = projectManagedClaimSource(f.document, f.stored, "b".repeat(64));
    expect(after.contentSha256).toBe(before.contentSha256); expect(after.claimsDigest).not.toBe(before.claimsDigest);
  });
  it("does not infer a missing claim number from the ordinal", () => {
    const f = fixture(); f.document.claims[0].claimNumber = null;
    expect(projectManagedClaimSource(f.document, f.stored, "b".repeat(64))).toMatchObject({ status: "review_required", claimsJson: null, reason: "claims_invalid" });
  });
  it("rejects mismatched stored text before attaching sidecar metadata", () => {
    const f = fixture(); f.stored.claimsText = f.stored.claimsText.slice(0, 2000);
    expect(() => projectManagedClaimSource(f.document, f.stored, "b".repeat(64))).toThrow("claims_invalid");
  });
  it.each([
    ["請求項１から３のいずれかに記載。", [1, 2, 3]],
    ["請求項1、2又は請求項５に記載。", [1, 2, 5]],
    ["請求項1に記載の装置と請求項3に記載の部材。", [1, 3]],
  ])("tracks explicit references: %s", (text, expected) => expect(managedClaimReferences(text)).toEqual(expected));
  it.each(["前記請求項のいずれかに記載。", "請求項3から1に記載。", "請求項一に記載。",
    "請求項1及び／又は2に記載。", "請求項1、2、又は3に記載。", "請求項1から3まで及び5に記載。",
    "請求項1並びに2に記載。", "請求項1と2に記載。"])("marks ambiguous references incomplete: %s", text => expect(() => managedClaimReferences(text)).toThrow());
});
