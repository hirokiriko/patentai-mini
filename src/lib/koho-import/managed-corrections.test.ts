import { describe, expect, it } from "vitest";
import { parseKohoXml } from "../koho-xml";
import { buildFictionalAmendmentXml, createFictionalKohoInput } from "../koho-xml/__fixtures__/fictional-koho";
import { managedCorrectionChanges, projectManagedCorrections } from "./managed-corrections";
import type { KohoPackageParseResult } from "../koho-package";
const description = '<jppat:AmendmentBag><com:DocumentName>A16330</com:DocumentName><jppat:AmendmentItem>０００１</jppat:AmendmentItem><jppat:AmendmentWay>3</jppat:AmendmentWay><jppat:AmendmentContentsBag><jppat:AmendmentDocumentNameCategory>Description</jppat:AmendmentDocumentNameCategory><com:P>完全架空の説明段落。</com:P></jppat:AmendmentContentsBag></jppat:AmendmentBag>';
const unit = (content: string) => '<jppat:WrittenAmendment><pat:FilingDate>2099-01-01</pat:FilingDate><jppat:AmendmentsBag>'+content+'</jppat:AmendmentsBag></jppat:WrittenAmendment>';
function result(content: string, originalDate = "2026-08-12") {
  const xml = buildFictionalAmendmentXml("A5", { previousPublicationDate: originalDate, annualNumber: "FICTIONAL-ANNUAL" })
    .replace(/<jppat:WrittenAmendmentBag>[\s\S]*?<\/jppat:WrittenAmendmentBag>/, '<jppat:WrittenAmendmentBag>'+content+'</jppat:WrittenAmendmentBag>');
  const parsed = parseKohoXml(createFictionalKohoInput("A5", { xml }));
  if (!("amendment" in parsed) || !parsed.amendment) throw Error("fixture");
  return parsed;
}
describe("correction provenance and conservative claim coverage", () => {
  it("keeps A5 original publication date and annual number", () => {
    const a = result(unit(description)).amendment!;
    expect(a.previousPublicationDate?.value).toBe("2026-08-12"); expect(a.annualNumber?.value).toBe("FICTIONAL-ANNUAL");
    expect(managedCorrectionChanges(a.amendmentContent)).toMatchObject({ claimsEffect: "none", changes: [{ documentName: "A16330", category: "Description", item: "０００１", way: "3" }] });
  });
  it.each([unit(description)+unit(""), unit(description.replace("<com:P>完全架空の説明段落。</com:P>", "")),
    unit(description.replace("Description", "Claims")), unit(description.replace("com:DocumentName", "jppat:DocumentName").replace("</com:DocumentName>", "</jppat:DocumentName>"))])("retains missing, unknown and claim-changing units as unresolved", content => {
    expect(managedCorrectionChanges(result(content).amendment!.amendmentContent).claimsEffect).toBe("unresolved");
  });
  it("gives a changed original-period header a different event identity even with identical body and path", () => {
    const project = (date: string) => projectManagedCorrections({ primaryXmlResults: [{ normalizedPath: "FICTIONAL.xml", result: result(unit(description), date) }], counts: { confirmedAmendments: 1 } } as KohoPackageParseResult)[0];
    const a = project("2026-08-12"), b = project("2026-07-12");
    expect(a.contentDigest).toBe(b.contentDigest); expect(a.eventKey).not.toBe(b.eventKey);
  });
});
