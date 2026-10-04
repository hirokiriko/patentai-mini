import { describe, expect, it } from "vitest";
import { parseKohoXml } from "./parser";
import { inspectKohoEntryPath } from "./path";
import { inspectEntryPath } from "../koho-zip/path";
import { buildFictionalCorrectionXml, createFictionalKohoInput, fictionalPrimaryEntryPath } from "./__fixtures__/fictional-koho";

const parse = (xml = buildFictionalCorrectionXml()) => parseKohoXml(createFictionalKohoInput("P6", { xml }));

describe("P6 correction identity and retained replacement material", () => {
  it.each(["xml", "image", "none"] as const)("preserves the %s correction as a distinct event", payload => {
    const r = parse(buildFictionalCorrectionXml({ payload }));
    expect(r).toMatchObject({ status: payload === "image" ? "review_required" : "success", entryType: "correction", kind: "P6", identityConfirmed: true });
    if (payload === "image") {
      expect(r.issues).toContainEqual(expect.objectContaining({ code: "unknown_inline_element", status: "review_required" }));
    }
    if (!("correction" in r) || !r.correction) throw Error("fixture correction");
    expect(r.correction.publicationNumber.value).toBe("2099000007");
    expect(r.correction.previousPublicationDate?.value).toBe("2099-02-11");
    expect(r.correction.correctedClaims).toHaveLength(payload === "xml" ? 2 : 0);
    expect(r.correction.correctionContent.localName).toBe("InternationalPatentPublicationCorrection");
    expect("document" in r).toBe(false);
    expect("amendment" in r).toBe(false);
  });

  it("keeps the domestic correction header independent of international payload identifiers", () => {
    const xml = buildFictionalCorrectionXml().replace("</jppat:InternationalPatentPublicationBibliographicData>",
      "<jppat:InternationalPublishingData><pat:PatentDocumentIdentification><pat:PublicationNumber>WO2099000999</pat:PublicationNumber></pat:PatentDocumentIdentification></jppat:InternationalPublishingData></jppat:InternationalPatentPublicationBibliographicData>");
    const r = parse(xml);
    expect(r).toMatchObject({ kind: "P6", identityConfirmed: true });
    if (!("correction" in r) || !r.correction) throw Error("fixture correction");
    expect(r.correction.publicationNumber.value).toBe("2099000007");
    expect(JSON.stringify(r.correction.correctionContent)).toContain("WO2099000999");
  });

  it("does not infer an absent original publication date from the event date", () => {
    const r = parse(buildFictionalCorrectionXml({ previousPublicationDate: null }));
    expect(r).toMatchObject({ kind: "P6", identityConfirmed: true });
    if (!("correction" in r) || !r.correction) throw Error("fixture correction");
    expect(r.correction.previousPublicationDate).toBeNull();
  });

  it.each([
    { kindCode: "A5", publicationNumber: "2099000007", publicationDate: "20990216" },
    { kindCode: "A6", publicationNumber: "2099000999", publicationDate: "20990216" },
    { kindCode: "A6", publicationNumber: "2099000007", publicationDate: "20990217" },
    { kindCode: "A6", publicationNumber: "2099000007" },
  ])("requires matching package kind, number and date: %j", indexHint => {
    expect(parseKohoXml(createFictionalKohoInput("P6", { indexHint }))).toMatchObject({
      status: "review_required", kind: "P6", identityConfirmed: false, correction: null,
    });
  });

  it.each([
    ["InternationalPatentPublicationCorrectionHeader", "correctionHeader"],
    ["PreviousPublicationDate", "correctionPreviousPublicationDate"],
    ["CorrectInternationalPatentPublication", "correctedPublication"],
  ])("does not select the first ambiguous %s", (tag, field) => {
    const xml = buildFictionalCorrectionXml();
    const match = xml.match(new RegExp(`<jppat:${tag}>[\\s\\S]*?</jppat:${tag}>`));
    if (!match) throw Error("fixture missing tag");
    const r = parse(xml.replace(match[0], match[0] + match[0]));
    expect(r).toMatchObject({ identityConfirmed: false, correction: null });
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "cardinality_mismatch", field }));
  });

  it("rejects the image and structured choices occurring together", () => {
    const r = parse(buildFictionalCorrectionXml().replace("<jppat:CorrectInternationalPatentPublication>",
      "<jppat:CorrectInternationalPatentPublication><jppat:CorrectOfficialGazetteImage><com:Image/></jppat:CorrectOfficialGazetteImage>"));
    expect(r).toMatchObject({ identityConfirmed: false, correction: null });
  });

  it.each([
    { schemaBasename: "JPInternationalPatentPublicationAmendment_V1_0.xsd" },
    { st96Version: "V999" },
    { ipoVersion: "JP_V999" },
    { languageCode: "en" },
  ])("does not confirm incompatible schema metadata %j", options => {
    expect(parse(buildFictionalCorrectionXml(options))).toMatchObject({ identityConfirmed: false });
  });

  it("rejects foreign root namespaces and unsafe paths", () => {
    expect(parse(buildFictionalCorrectionXml().replace("http://www.jpo.go.jp/standards/XMLSchema/ST96/JPPatent", "https://invalid.example/fictional"))).toMatchObject({ status: "unsupported_type" });
    expect(parseKohoXml(createFictionalKohoInput("P6", { entryPath: "../FICTIONAL.xml" }))).toMatchObject({ status: "failed" });
  });
});

describe("P6 exact primary-path selection", () => {
  it("agrees between ZIP classification and XML identity without changing the entry path", () => {
    const path = fictionalPrimaryEntryPath("P6");
    expect(inspectEntryPath(path)).toMatchObject({ normalizedPath: path, pathCandidate: "primary_xml" });
    expect(inspectKohoEntryPath(path)).toMatchObject({ section: "P_P6", isPrimaryXml: true, documentNumber: "2099000007" });
  });
  it.each([
    "DOCUMENT/P_P6/999900/999990/2099000007/2099000008.xml",
    "DOCUMENT/P_UNKNOWN/999900/999990/2099000007/2099000007.xml",
    "DOCUMENT/P_P6/999900/999990/2099000007/2099000007.XML",
  ])("retains noncanonical primary paths as unclassified: %s", path => {
    expect(inspectEntryPath(path).pathCandidate).toBe("none");
    expect(inspectKohoEntryPath(path)).toMatchObject({ isPrimaryXml: false });
  });
});
