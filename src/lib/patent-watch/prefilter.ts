import type { ExtractedClaims } from "../extract-claims";
import {
  createPatentWatchSourceKey,
  isPositiveSafeInteger,
  isValidPatentWatchTimestamp,
  isValidPatentWatchDate,
  PatentWatchDomainError,
} from "./domain";
import type { PatentWatchCorpusDocument } from "./types";

const MAX_PREFILTER_CANDIDATES = 100;
const CJK_RUN_PATTERN =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const WORD_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|[\p{L}\p{M}\p{N}]+/gu;

export interface PatentWatchPrefilterCandidate {
  document: PatentWatchCorpusDocument;
  sourceKey: string;
  score: number;
  matchedTokens: string[];
}

export interface PatentWatchPrefilterOptions {
  existingSourceKeys?: ReadonlySet<string>;
  limit?: number;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * NFCだけでcanonical equivalenceを揃える。互換文字を畳むNFKCは使用しない。
 * CJKの連続列はUnicode code point単位の隣接2-gram、その他は語単位にする。
 */
export function tokenizePatentWatchText(value: string): string[] {
  const normalized = value.normalize("NFC").toLowerCase();
  const tokens = new Set<string>();

  for (const match of normalized.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (!CJK_RUN_PATTERN.test(word)) {
      tokens.add(word);
      continue;
    }

    const codePoints = Array.from(word);
    if (codePoints.length < 2) {
      tokens.add(word);
      continue;
    }
    for (let index = 0; index < codePoints.length - 1; index += 1) {
      tokens.add(codePoints[index] + codePoints[index + 1]);
    }
  }

  return [...tokens].sort(compareText);
}

/** 重複を除いたtoken集合に対するSørensen–Dice係数（小数6桁）。 */
export function lexicalOverlapScore(
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const score = (2 * intersection) / (left.size + right.size);
  return Math.round(score * 1_000_000) / 1_000_000;
}

function selectedClaimText(extracted: ExtractedClaims): string {
  const independent = extracted.claims.filter(
    (claim) => claim.isIndependent,
  );
  const selected = independent.length > 0 ? independent : extracted.claims;
  return selected.map((claim) => claim.text).join("\n");
}

function validateDocument(
  value: PatentWatchCorpusDocument,
): PatentWatchCorpusDocument {
  if (
    !isPositiveSafeInteger(value.documentId) ||
    !isPositiveSafeInteger(value.importId) ||
    typeof value.importRunUpdatedAt !== "string" ||
    !isValidPatentWatchTimestamp(value.importRunUpdatedAt) ||
    (value.packageType !== "JPA" && value.packageType !== "JPB") ||
    !["A1", "P1", "B1", "B2"].includes(value.kind) ||
    (value.packageType === "JPA" &&
      value.kind !== "A1" &&
      value.kind !== "P1") ||
    (value.packageType === "JPB" &&
      value.kind !== "B1" &&
      value.kind !== "B2") ||
    typeof value.publicationNumber !== "string" ||
    value.publicationNumber.length === 0 ||
    value.publicationNumber.trim() !== value.publicationNumber ||
    !isValidPatentWatchDate(value.publicationDate) ||
    typeof value.inventionTitle !== "string" ||
    (value.abstractText !== null && typeof value.abstractText !== "string") ||
    typeof value.claimsText !== "string" ||
    typeof value.contentSha256 !== "string"
  ) {
    throw new PatentWatchDomainError("watch_corpus_unavailable");
  }

  // identity helper also validates lowercase SHA-256.
  createPatentWatchSourceKey(value.publicationNumber, value.contentSha256);
  return {
    documentId: value.documentId,
    importId: value.importId,
    importRunUpdatedAt: value.importRunUpdatedAt,
    packageType: value.packageType,
    kind: value.kind,
    publicationNumber: value.publicationNumber,
    publicationDate: value.publicationDate,
    inventionTitle: value.inventionTitle,
    abstractText: value.abstractText,
    claimsText: value.claimsText,
    contentSha256: value.contentSha256,
  };
}

function compareCandidates(
  left: PatentWatchPrefilterCandidate,
  right: PatentWatchPrefilterCandidate,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.document.publicationDate !== right.document.publicationDate) {
    return left.document.publicationDate > right.document.publicationDate
      ? -1
      : 1;
  }
  const publicationOrder = compareText(
    left.document.publicationNumber,
    right.document.publicationNumber,
  );
  if (publicationOrder !== 0) return publicationOrder;
  return left.document.documentId - right.document.documentId;
}

export function prefilterPatentWatchDocuments(
  extracted: ExtractedClaims,
  values: readonly PatentWatchCorpusDocument[],
  options: PatentWatchPrefilterOptions = {},
): PatentWatchPrefilterCandidate[] {
  const limit = options.limit ?? MAX_PREFILTER_CANDIDATES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PatentWatchDomainError("watch_internal_error");
  }

  const claimTokens = tokenizePatentWatchText(selectedClaimText(extracted));
  if (claimTokens.length === 0) return [];

  const candidates = values
    .map(validateDocument)
    .map((document): PatentWatchPrefilterCandidate => {
      const sourceTokens = tokenizePatentWatchText(
        [
          document.inventionTitle,
          document.abstractText ?? "",
          document.claimsText,
        ].join("\n"),
      );
      const sourceTokenSet = new Set(sourceTokens);
      const matchedTokens = claimTokens.filter((token) =>
        sourceTokenSet.has(token),
      );
      return {
        document,
        sourceKey: createPatentWatchSourceKey(
          document.publicationNumber,
          document.contentSha256,
        ),
        score: lexicalOverlapScore(claimTokens, sourceTokens),
        matchedTokens,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates);

  const selected: PatentWatchPrefilterCandidate[] = [];
  const seenSourceKeys = new Set<string>();
  for (const candidate of candidates) {
    if (
      seenSourceKeys.has(candidate.sourceKey) ||
      options.existingSourceKeys?.has(candidate.sourceKey)
    ) {
      continue;
    }
    seenSourceKeys.add(candidate.sourceKey);
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}
