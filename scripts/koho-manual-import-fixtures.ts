/** Entirely fictional publications. No real patent or operator data is used. */
import { buildZip } from "../src/lib/koho-zip/__fixtures__/zip-builder";
import { buildFictionalFullPublicationXml, buildFictionalAmendmentXml, fictionalPrimaryEntryPath } from "../src/lib/koho-xml/__fixtures__/fictional-koho";
import { fictionalAbstractCsv, fictionalContents1Csv, fictionalContents2Csv } from "../src/lib/koho-package/__fixtures__/fictional-package";

export function manualFixture(type: "JPA" | "JPB", count = 1, options: {
  issue?: string; review?: boolean; unknown?: boolean; indexMismatch?: boolean; changed?: boolean;
  publicationDate?: string; amendment?: boolean;
} = {}) {
  const section = type === "JPA" ? "P_A1" : "P_B1", kind = type === "JPA" ? "A1" : "B1";
  const numbers = Array.from({ length: count }, (_, n) => String((type === "JPA" ? 2099000101 : 9999901) + n));
  const dates = numbers.map((_, n) => options.publicationDate ?? `2099-03-${String(11 + n).padStart(2, "0")}`);
  const entries = [
    { fileName: "ABSTRACT.csv", data: fictionalAbstractCsv(type)
      .replace(/FICTIONAL-ISSUE-\d+/, options.issue ?? "FICTIONAL-ISSUE-MANUAL")
      .replace(type === "JPA" ? "20990111" : "20990311", options.publicationDate?.replaceAll("-", "") ?? (type === "JPA" ? "20990111" : "20990311"))
      .replace("00001", String(count).padStart(5, "0")) },
    { fileName: "DOCUMENT_LIST.csv", data: numbers.map((num, n) =>
      `JP,${options.indexMismatch ? "2099000000" : num},${type === "JPA" ? "A" : "B1"},${dates[n].replaceAll("-", "")}\r\n`).join("") },
    { fileName: `DOCUMENT/${section}/CONTENTS1.csv`, data: numbers.map(num => fictionalContents1Csv(type, num)).join("") },
    { fileName: `DOCUMENT/${section}/CONTENTS2.csv`, data: numbers.map(num => fictionalContents2Csv(type, num)).join("") },
    ...numbers.map((num, n) => ({ fileName: `DOCUMENT/${section}/999900/999990/${num}/${num}.xml`,
      data: options.unknown ? "<FICTIONAL-UNKNOWN/>" : buildFictionalFullPublicationXml(kind, {
        publicationNumber: num, publicationDate: dates[n],
        inventionTitle: options.changed ? "完全架空の変更された検証用発明" : "完全架空の検証用発明",
        ...(options.review ? { abstract: null } : {}),
      }) })),
  ];
  if (options.amendment && type === "JPA") {
    entries[0].data += "補正の掲載（公開特許公報）,FICTIONAL-A5-RANGE,00001\r\n";
    entries[1].data += `JP,2099000005,A5,${(options.publicationDate ?? "2099-01-15").replaceAll("-", "")}\r\n`;
    entries.push({ fileName: fictionalPrimaryEntryPath("A5"), data: buildFictionalAmendmentXml("A5", { publicationDate: options.publicationDate }) },
      { fileName: `DOCUMENT/P_A1/999900/999990/${numbers[0]}/FICTIONAL.png`, data: "FICTIONAL-IMAGE" });
  }
  return buildZip({ entries }).bytes;
}
