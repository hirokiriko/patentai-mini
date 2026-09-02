import { describe, expect, it } from "vitest";

import { buildPatentWatchReportCsv } from "./csv";
import type { CaseWatchFinding } from "./types";

function finding(
  overrides: Partial<CaseWatchFinding> = {},
): CaseWatchFinding {
  return {
    findingId: 1,
    watchId: 2,
    firstRunId: 3,
    sourceKey: "a".repeat(64),
    corpusDocumentId: 4,
    packageType: "JPA",
    kind: "A1",
    publicationNumber: "JP2099-000001A",
    publicationDate: "20990102",
    inventionTitle: "架空の光学装置",
    abstractPreview: "架空の要約",
    lexicalScore: 0.8,
    elementScore: 0.7,
    semanticScore: 0.6,
    structuralScore: 0.5,
    riskLabel: "Medium",
    analysisJson: JSON.stringify({
      matchedElements: ["架空の光学部"],
      unmatchedElements: ["架空の制約"],
      explanation: "比較候補です。人による確認が必要です",
    }),
    analysisMode: "ai",
    reviewStatus: "unreviewed",
    firstSeenAt: "2099-01-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("patent watch CSV", () => {
  it("emits only the exact public columns as UTF-8 text", () => {
    const csv = buildPatentWatchReportCsv([finding()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      "公開番号,公開日,kind,発明名称,risk label,lexical score,element score,semantic score,structural score,一致候補,差分候補,説明,分析mode,確認状態",
    );
    expect(csv).toContain("架空の光学装置");
  });

  it("escapes commas, quotes, and line breaks", () => {
    const csv = buildPatentWatchReportCsv([
      finding({
        inventionTitle: "架空,\"引用\"\n名称",
        analysisJson: JSON.stringify({
          matchedElements: ["alpha,beta", "line\nbreak"],
          unmatchedElements: [],
          explanation: "one\r\ntwo",
        }),
      }),
    ]);
    expect(csv).toContain('"架空,""引用""\n名称"');
    expect(csv).toContain('"alpha,beta / line\nbreak"');
    expect(csv).toContain('"one\r\ntwo"');
  });

  it("bounds public metadata even when a stored row is oversized", () => {
    const longPublicationNumber = "P".repeat(101);
    const longTitle = "架".repeat(501);
    const csv = buildPatentWatchReportCsv([
      finding({
        publicationNumber: longPublicationNumber,
        inventionTitle: longTitle,
      }),
    ]);

    expect(csv).toContain("P".repeat(100));
    expect(csv).not.toContain(longPublicationNumber);
    expect(csv).toContain("架".repeat(500));
    expect(csv).not.toContain(longTitle);
  });

  it.each([
    "=1+1",
    "+cmd",
    "-2+3",
    "@SUM(A1)",
    "\t=cmd",
    "\uFEFF=cmd",
    "\u200B=cmd",
    "\u0000=cmd",
  ])(
    "neutralizes formula injection: %s",
    (payload) => {
      const csv = buildPatentWatchReportCsv([
        finding({ inventionTitle: payload }),
      ]);
      expect(csv).toContain(`'${payload}`);
    },
  );

  it("never exposes identity hashes, raw fields, or paths", () => {
    const sourceKey = "a".repeat(64);
    const leakedDigest = "b".repeat(64);
    const localPath = ["C:", "\\", "private\\fictional.xml"].join("");
    const signedUrlSecret = "FICTIONAL_SAS_SIGNATURE";
    const sessionSecret = "FICTIONAL_SESSION_SECRET";
    const signedUrl = [
      "https",
      "://",
      "fictional.blob.core.windows.net/private?sv=2099-01-01&sig=",
      signedUrlSecret,
    ].join("");
    const csv = buildPatentWatchReportCsv([
      {
        ...finding({
          sourceKey,
          inventionTitle: `架空 ${leakedDigest}`,
          analysisJson: JSON.stringify({
            matchedElements: [
              signedUrl,
              `Set-Cookie: session=${sessionSecret}; HttpOnly`,
            ],
            unmatchedElements: [
              `{"credential":"${sessionSecret}"}`,
            ],
            explanation: `${localPath} ${leakedDigest}`,
          }),
        }),
        rawXml: "FICTIONAL-RAW-XML-SENTINEL",
        claimsText: "FICTIONAL-FULL-CLAIMS-SENTINEL",
        dbError: "FICTIONAL-DB-ERROR-SENTINEL",
      } as CaseWatchFinding,
    ]);
    for (const forbidden of [
      sourceKey,
      leakedDigest,
      localPath,
      signedUrlSecret,
      sessionSecret,
      "FICTIONAL-RAW-XML-SENTINEL",
      "FICTIONAL-FULL-CLAIMS-SENTINEL",
      "FICTIONAL-DB-ERROR-SENTINEL",
    ]) {
      expect(csv).not.toContain(forbidden);
    }
  });
});
