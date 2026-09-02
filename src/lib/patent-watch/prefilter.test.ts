import { describe, expect, it } from "vitest";

import type { ExtractedClaims } from "../extract-claims";
import {
  lexicalOverlapScore,
  prefilterPatentWatchDocuments,
  tokenizePatentWatchText,
} from "./prefilter";
import type { PatentWatchCorpusDocument } from "./types";

const DIGEST = "a".repeat(64);

function extractedClaims(
  claims: Array<{
    claimNo: number;
    text: string;
    isIndependent: boolean;
  }>,
): ExtractedClaims {
  return {
    title: "完全に架空の発明",
    abstract: "完全に架空の要約",
    solvedProblems: [],
    effects: [],
    claims: claims.map((claim) => ({
      ...claim,
      dependsOn: claim.isIndependent ? null : 1,
      elements: [
        { type: "component", text: claim.text, importance: "core" },
      ],
    })),
  };
}

function document(
  documentId: number,
  title: string,
  overrides: Partial<PatentWatchCorpusDocument> = {},
): PatentWatchCorpusDocument {
  return {
    documentId,
    importId: 100 + documentId,
    importRunUpdatedAt: "2096-03-01T00:00:00.000Z",
    packageType: "JPA",
    kind: "A1",
    publicationNumber: `JP2096-${String(documentId).padStart(6, "0")}A`,
    publicationDate: "20960301",
    inventionTitle: title,
    abstractText: null,
    claimsText: "",
    contentSha256: DIGEST,
    ...overrides,
  };
}

describe("Unicode-aware patent watch tokenization", () => {
  it("normalizes canonical Unicode and case without compatibility folding", () => {
    expect(tokenizePatentWatchText("Cafe\u0301 SENSOR")).toEqual(
      tokenizePatentWatchText("Café sensor"),
    );
    expect(tokenizePatentWatchText("ＳＥＮＳＯＲ")).not.toEqual(
      tokenizePatentWatchText("SENSOR"),
    );
  });

  it("produces useful CJK tokens without splitting surrogate pairs", () => {
    const tokens = tokenizePatentWatchText("架空光学センサー 𠮷置");
    expect(tokens).toContain("架空");
    expect(tokens).toContain("光学");
    expect(tokens.some((token) => token.includes("𠮷"))).toBe(true);
  });

  it("uses a fixed set-based Dice score", () => {
    expect(lexicalOverlapScore(["alpha", "beta"], ["beta", "gamma"])).toBe(
      0.5,
    );
    expect(lexicalOverlapScore([], ["beta"])).toBe(0);
  });
});

describe("patent watch deterministic prefilter", () => {
  it("uses independent claims and ignores dependent-only matches", () => {
    const claims = extractedClaims([
      { claimNo: 1, text: "orbital prism detector", isIndependent: true },
      { claimNo: 2, text: "nectar turbine", isIndependent: false },
    ]);

    const result = prefilterPatentWatchDocuments(claims, [
      document(1, "nectar turbine"),
      document(2, "orbital prism"),
    ]);

    expect(result.map((candidate) => candidate.document.documentId)).toEqual([
      2,
    ]);
  });

  it("uses all claims when no independent claim exists", () => {
    const claims = extractedClaims([
      { claimNo: 1, text: "nectar turbine", isIndependent: false },
    ]);
    expect(
      prefilterPatentWatchDocuments(claims, [document(3, "nectar turbine")]),
    ).toHaveLength(1);
  });

  it("sorts by score, publication date, publication number, then document id", () => {
    const claims = extractedClaims([
      { claimNo: 1, text: "orbital prism", isIndependent: true },
    ]);
    const result = prefilterPatentWatchDocuments(claims, [
      document(9, "orbital prism", {
        publicationDate: "20960102",
        publicationNumber: "JP2096-000009A",
      }),
      document(8, "orbital prism", {
        publicationDate: "20960103",
        publicationNumber: "JP2096-000010A",
      }),
      document(7, "orbital prism", {
        publicationDate: "20960103",
        publicationNumber: "JP2096-000008A",
        contentSha256: "b".repeat(64),
      }),
      document(6, "orbital prism", {
        publicationDate: "20960103",
        publicationNumber: "JP2096-000008A",
      }),
    ]);

    expect(result.map((candidate) => candidate.document.documentId)).toEqual([
      6, 7, 8, 9,
    ]);
  });

  it("does not backfill zero-score documents and limits AI candidates to 100", () => {
    const claims = extractedClaims([
      { claimNo: 1, text: "orbital", isIndependent: true },
    ]);
    const matches = Array.from({ length: 120 }, (_, index) =>
      document(index + 1, `orbital ${index + 1}`),
    );
    const result = prefilterPatentWatchDocuments(claims, [
      ...matches,
      document(500, "unrelated nectar"),
    ]);

    expect(result).toHaveLength(100);
    expect(result.every((candidate) => candidate.score > 0)).toBe(true);
    expect(
      result.some((candidate) => candidate.document.documentId === 500),
    ).toBe(false);
  });

  it("removes existing and same-run duplicate source identities before limit", () => {
    const claims = extractedClaims([
      { claimNo: 1, text: "orbital", isIndependent: true },
    ]);
    const duplicate = document(20, "orbital", {
      publicationNumber: "JP2096-000020A",
      contentSha256: "b".repeat(64),
    });
    const sameIdentity = document(21, "orbital", {
      importId: 999,
      packageType: "JPB",
      kind: "B1",
      publicationNumber: duplicate.publicationNumber,
      contentSha256: duplicate.contentSha256,
    });
    const initial = prefilterPatentWatchDocuments(claims, [
      duplicate,
      sameIdentity,
    ]);
    expect(initial).toHaveLength(1);

    const result = prefilterPatentWatchDocuments(
      claims,
      [duplicate, sameIdentity],
      { existingSourceKeys: new Set([initial[0].sourceKey]) },
    );
    expect(result).toEqual([]);
  });
});
