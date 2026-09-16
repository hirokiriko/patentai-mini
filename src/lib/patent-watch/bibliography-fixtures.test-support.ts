import { createPatentWatchSourceKey } from "./domain";

export const applicantJson = (names = ["完全架空の出願人株式会社", "架空 太郎"]) => JSON.stringify(names.map((value, ordinal) => ({
  ordinal, sequenceNumber: String(ordinal + 1), names: [{ value, sourceValue: value, originalLanguageIndicator: null }],
})));
export function bibliographyFixture(kind: "A1" | "P1" | "B1" | "B2" = "A1") {
  const registered = kind === "B1" || kind === "B2";
  const publicationNumber = registered ? "9999991" : "2099000001";
  const packageType = registered ? "JPB" : "JPA", contentSha256 = "a".repeat(64);
  return {
    finding: { findingId: 11, firstRunId: 3, publicationNumber, kind, packageType, sourceKey: createPatentWatchSourceKey(publicationNumber, contentSha256) },
    document: { documentId: 17, publicationNumber, kind, packageType, contentSha256, parseStatus: "success", publicationDate: "2099-03-11",
      applicationNumber: "2098000001", registrationNumber: registered ? publicationNumber : null, registrationDate: registered ? "2099-03-01" : null,
      inventionTitle: "完全架空の検証用発明", applicantsJson: applicantJson() },
  };
}
