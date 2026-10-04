/** Fictional P6 plus one ordinary publication; no production input is used. */
import { buildZip } from "../koho-zip/__fixtures__/zip-builder";
import { buildFictionalCorrectionXml, buildFictionalFullPublicationXml, fictionalPrimaryEntryPath } from "../koho-xml/__fixtures__/fictional-koho";
import { fictionalAbstractCsv, fictionalContents1Csv, fictionalContents2Csv } from "../koho-package/__fixtures__/fictional-package";

export function fictionalP6Package(options: { previousPublicationDate?: string | null; payload?: "xml" | "image" | "none" } = {}) {
  const date = "2026-08-12", number = "2099000001";
  const label = "訂正(公表特許公報)(P_P6)";
  const width = Array.from(label).reduce((n, char) => n + (char.codePointAt(0)! <= 0x7f ? 1 : 2), 0);
  const correctionXml = buildFictionalCorrectionXml({ publicationDate: date, previousPublicationDate: options.previousPublicationDate ?? "2026-08-11", payload: options.payload ?? "xml" });
  return buildZip({ entries: [
    { fileName: "ABSTRACT.csv", data: fictionalAbstractCsv("JPA").replace("20990111", "20260812").replace("FICTIONAL-ISSUE-0001", "2026-148").replace("01122", "01115") +
      `${label}${" ".repeat(80 - width)},FICTIONAL-P6-RANGE,00001\r\n` },
    { fileName: "DOCUMENT_LIST.csv", data: `JP,${number},A,20260812\r\nJP,2099000007,A6,20260812\r\n` },
    { fileName: "DOCUMENT/P_A1/CONTENTS1.csv", data: fictionalContents1Csv("JPA", number) },
    { fileName: "DOCUMENT/P_A1/CONTENTS2.csv", data: fictionalContents2Csv("JPA", number) },
    { fileName: fictionalPrimaryEntryPath("A1"), data: buildFictionalFullPublicationXml("A1", { publicationDate: date }) },
    { fileName: fictionalPrimaryEntryPath("P6"), data: options.previousPublicationDate === null ?
      correctionXml.replace(/<(?:com|pat|jppat):PreviousPublicationDate>[^<]*<\/(?:com|pat|jppat):PreviousPublicationDate>/, "") : correctionXml },
  ] }).bytes;
}
