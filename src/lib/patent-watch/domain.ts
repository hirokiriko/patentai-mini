import { createHash } from "node:crypto";

import type {
  PatentWatchAnalysisJson,
  PatentWatchCursor,
  PatentWatchErrorCode,
  PatentWatchReviewStatus,
  PatentWatchSettingInput,
} from "./types";

const YYYYMMDD_PATTERN = /^[0-9]{8}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;
const REVIEW_STATUSES = new Set<PatentWatchReviewStatus>([
  "unreviewed",
  "reviewed",
]);

const LEGAL_SUBJECT_PATTERN = String.raw`\b(?:(?:the|this|that|these|those|each|all)\s+)?(?:claims?|inventions?|applications?|subject\s+matter|claimed\s+(?:inventions?|subject\s+matter))\b`;
const LEGAL_STRONG_SUBJECT_PATTERN = String.raw`\b(?:(?:the|this|that|these|those|each|all)\s+)?(?:claims?|inventions?|subject\s+matter|claimed\s+(?:inventions?|subject\s+matter))\b`;
const CLAIM_IDENTIFIER_PATTERN = String.raw`(?:(?:nos?\.?|number(?:s|ed)?\.?)\s*)?(?:#\s*)?(?:\d+[a-z]?(?:\s*\([a-z0-9]+\))*|[ivxlcdm]+|[a-z]\d*)`;
const CLAIM_IDENTIFIER_CONNECTOR_PATTERN = String.raw`(?:\s*,\s*(?:(?:and|or)\s+)?|\s*(?:&|[-\u2010-\u2014])\s*|\s+(?:and|or|to|through)\s+)`;
const LEGAL_SUBJECT_WITH_IDENTIFIER_PATTERN = `${LEGAL_SUBJECT_PATTERN}(?:\\s+${CLAIM_IDENTIFIER_PATTERN}(?:${CLAIM_IDENTIFIER_CONNECTOR_PATTERN}${CLAIM_IDENTIFIER_PATTERN})*)?`;
const LEGAL_STRONG_SUBJECT_WITH_IDENTIFIER_PATTERN = `${LEGAL_STRONG_SUBJECT_PATTERN}(?:\\s+${CLAIM_IDENTIFIER_PATTERN}(?:${CLAIM_IDENTIFIER_CONNECTOR_PATTERN}${CLAIM_IDENTIFIER_PATTERN})*)?`;
const LEGAL_APPLICATION_SUBJECT_PATTERN = String.raw`\b(?:(?:the|this|that|these|those|each|all)\s+)?(?:patent\s+)?applications?(?:\s+(?:#\s*)?\d+)?\b`;
const LEGAL_SUBJECT_PREDICATE_SEPARATOR_PATTERN = String.raw`(?:\s*:\s*|\s+)`;
const LEGAL_PREDICATE_QUALIFIER_TOKEN_PATTERN = String.raw`(?:not|never|well|very|still|yet|indeed|and|or|[a-z]+ly)`;
const LEGAL_PREDICATE_QUALIFIER_PATTERN = String.raw`(?:${LEGAL_PREDICATE_QUALIFIER_TOKEN_PATTERN}\s+){0,6}`;
const LEGAL_APPEARANCE_LINK_PATTERN = String.raw`(?:appear(?:s|ed)?|seem(?:s|ed)?|look(?:s|ed)?)(?:(?:\s+${LEGAL_PREDICATE_QUALIFIER_TOKEN_PATTERN}){0,2}\s+to\s+be)?`;
const LEGAL_JUDGMENT_LINK_PATTERN = String.raw`(?:(?:is|are|was|were|remain(?:s|ed)?)|(?:is|are|was|were)\s+${LEGAL_PREDICATE_QUALIFIER_PATTERN}being|(?:has|have|had)\s+${LEGAL_PREDICATE_QUALIFIER_PATTERN}been|(?:will|would|could|should|may|might|can|must)\s+${LEGAL_PREDICATE_QUALIFIER_PATTERN}(?:be|have\s+been|${LEGAL_APPEARANCE_LINK_PATTERN})|${LEGAL_APPEARANCE_LINK_PATTERN})`;
const LEGAL_PREDICATE_ASSESSMENT_LINK_PATTERN = String.raw`(?:(?:considered|deemed|believed|expected|found|determined|judged|held)\s+(?:to\s+be\s+)?|(?:likely|unlikely)\s+to\s+be\s+)`;
const LEGAL_PREDICATE_ASSESSMENT_PATTERN = String.raw`${LEGAL_PREDICATE_QUALIFIER_PATTERN}(?:${LEGAL_PREDICATE_ASSESSMENT_LINK_PATTERN}${LEGAL_PREDICATE_QUALIFIER_PATTERN}){0,2}`;
const LEGAL_NOVELTY_PREDICATE_PATTERN = String.raw`${LEGAL_JUDGMENT_LINK_PATTERN}\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}(?:novel|new)\b(?![-\u2010\u2011]\p{L})`;
const PATENT_PUBLICATION_ID_PATTERN = String.raw`(?:(?:(?:jp|us|wo|ep|cn|kr|de|gb|fr|ca|au|in|br|mx|ru|tw|sg|nz|es|it|se|no|dk|fi|nl|be|ch|at|pl|cz|za|il|my|th|ph|vn|id)\s?(?:\d{5,}[a-z0-9./-]*|\d{4}(?:[-/.]\d{3,}[a-z0-9./-]*|[a-z]\d+[a-z0-9./-]*)))|jp[hsr]\d{2}[-/]?\d{4,}[a-z]\d?|ep[-/][ab]\d?[-/]\d{5,}[a-z0-9]*)`;
const LEGAL_ANTICIPATION_SOURCE_PATTERN = String.raw`(?:(?:the\s+)?(?:prior\s+art|references?|documents?|sources?|publications?|patents?|patent\s+publications?|cited\s+art)|[dr]\d+|${PATENT_PUBLICATION_ID_PATTERN}|[a-z][\p{L}\p{M}'’-]{1,40}\s+et\s+al\.?)(?![\p{L}\p{M}\p{N}_])`;
const LEGAL_NAMED_CITATION_SOURCE_PATTERN = String.raw`(?!(?:january|february|march|april|may|june|july|august|september|october|november|december)\b)[\p{L}\p{M}'’-]{2,40}(?=\s*(?:[.,;:!?]|$))`;
const LEGAL_SOURCE_QUALIFIED_SUBJECT_SUFFIX_PATTERN = String.raw`(?:\s*,?\s*(?:in\s+(?:view|light)\s+of|over|based\s+(?:on|upon)|according\s+to)\s+${LEGAL_ANTICIPATION_SOURCE_PATTERN}\s*,?)?`;
const LEGAL_SUBJECT_PREDICATE_PREFIX_PATTERN = `${LEGAL_SUBJECT_WITH_IDENTIFIER_PATTERN}${LEGAL_SOURCE_QUALIFIED_SUBJECT_SUFFIX_PATTERN}${LEGAL_SUBJECT_PREDICATE_SEPARATOR_PATTERN}`;
const LEGAL_STRONG_SUBJECT_PREDICATE_PREFIX_PATTERN = `${LEGAL_STRONG_SUBJECT_WITH_IDENTIFIER_PATTERN}${LEGAL_SOURCE_QUALIFIED_SUBJECT_SUFFIX_PATTERN}${LEGAL_SUBJECT_PREDICATE_SEPARATOR_PATTERN}`;
const LEGAL_APPLICATION_SUBJECT_PREDICATE_PREFIX_PATTERN = `${LEGAL_APPLICATION_SUBJECT_PATTERN}${LEGAL_SOURCE_QUALIFIED_SUBJECT_SUFFIX_PATTERN}${LEGAL_SUBJECT_PREDICATE_SEPARATOR_PATTERN}`;
const LEGAL_APPLICATION_NOVELTY_CONTINUATION_PATTERN = String.raw`(?=\s*(?:[.,;:!?]|$)|\s+(?:(?:over|in\s+(?:view|light)\s+of|based\s+(?:on|upon))\s+${LEGAL_ANTICIPATION_SOURCE_PATTERN}))`;
const LEGAL_SUBJECT_NOVELTY_PATTERN = new RegExp(
  `${LEGAL_STRONG_SUBJECT_PREDICATE_PREFIX_PATTERN}${LEGAL_NOVELTY_PREDICATE_PATTERN}`,
  "iu",
);
const LEGAL_APPLICATION_NOVELTY_PATTERN = new RegExp(
  `${LEGAL_APPLICATION_SUBJECT_PREDICATE_PREFIX_PATTERN}${LEGAL_NOVELTY_PREDICATE_PATTERN}${LEGAL_APPLICATION_NOVELTY_CONTINUATION_PATTERN}`,
  "iu",
);
const LEGAL_ANTICIPATION_STATUTE_PATTERN = String.raw`(?:35\s+u\.?\s*s\.?\s*c\.?(?:\s*§?\s*\d+)?|section\s+\d+[a-z0-9().-]*)`;
const LEGAL_NUMBERED_CLAIM_OBJECT_PATTERN = String.raw`\bclaims?\s+${CLAIM_IDENTIFIER_PATTERN}(?:${CLAIM_IDENTIFIER_CONNECTOR_PATTERN}${CLAIM_IDENTIFIER_PATTERN})*(?![\p{L}\p{M}\p{N}_])`;
const LEGAL_NUMBERED_APPLICATION_OBJECT_PATTERN = String.raw`\b(?:patent\s+)?applications?\s+(?:(?:nos?\.?|number(?:s|ed)?\.?)\s*)?(?:#\s*)?\d+(?![\p{L}\p{M}\p{N}_])`;
const LEGAL_TERMINAL_OBJECT_CONTINUATION_PATTERN = String.raw`(?=\s*(?:[.,;:!?]|$)|\s+(?:as\s+(?:filed|claimed|drafted|published|disclosed)|in\s+(?:(?:the|its)\s+)?(?:filed|claimed|published)\s+form)\b)`;
const LEGAL_TERMINAL_ANTICIPATION_OBJECT_PATTERN = String.raw`\b(?:claims?|(?:(?:the|this|that|these|those|claimed)\s+)?inventions?|subject\s+matter|(?:the|this|that|these|those|patent)\s+applications?)\b${LEGAL_TERMINAL_OBJECT_CONTINUATION_PATTERN}`;
const LEGAL_CORE_REFERENCE_PATTERN = String.raw`(?:${LEGAL_NUMBERED_CLAIM_OBJECT_PATTERN}|${LEGAL_NUMBERED_APPLICATION_OBJECT_PATTERN}|${LEGAL_TERMINAL_ANTICIPATION_OBJECT_PATTERN})`;
const LEGAL_CORE_ANTICIPATION_OBJECT_PATTERN = String.raw`(?:(?:${LEGAL_NUMBERED_CLAIM_OBJECT_PATTERN}|${LEGAL_NUMBERED_APPLICATION_OBJECT_PATTERN})${LEGAL_TERMINAL_OBJECT_CONTINUATION_PATTERN}|${LEGAL_TERMINAL_ANTICIPATION_OBJECT_PATTERN})`;
const LEGAL_ANTICIPATION_OBJECT_PATTERN = LEGAL_CORE_ANTICIPATION_OBJECT_PATTERN;
const LEGAL_SUBJECT_ANTICIPATED_PATTERN = String.raw`${LEGAL_SUBJECT_PREDICATE_PREFIX_PATTERN}${LEGAL_JUDGMENT_LINK_PATTERN}\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}anticipated\b`;
const LEGAL_ANTICIPATION_PASSIVE_CONTINUATION_PATTERN = String.raw`(?:(?=\s*(?:[.,;:!?]|$))|\s+(?:(?:(?:by|in|over)\s+(?:${LEGAL_ANTICIPATION_SOURCE_PATTERN}|${LEGAL_NAMED_CITATION_SOURCE_PATTERN})|(?:based\s+(?:on|upon)|according\s+to)\s+${LEGAL_ANTICIPATION_SOURCE_PATTERN})|as\s+(?:[a-z]+ly\s+){0,3}(?:disclosed|taught|described)\s+(?:in|by)\s+${LEGAL_ANTICIPATION_SOURCE_PATTERN}|under\s+(?:${LEGAL_ANTICIPATION_SOURCE_PATTERN}|${LEGAL_ANTICIPATION_STATUTE_PATTERN})))`;
const LEGAL_SUBJECT_ANTICIPATION_PATTERN = new RegExp(
  `${LEGAL_SUBJECT_ANTICIPATED_PATTERN}${LEGAL_ANTICIPATION_PASSIVE_CONTINUATION_PATTERN}`,
  "iu",
);
const LEGAL_SOURCE_ANTICIPATION_PATTERN = new RegExp(
  String.raw`\b${LEGAL_ANTICIPATION_SOURCE_PATTERN}(?:\s*:\s*)?[^.!?;:\r\n]{0,40}\banticipat(?:e[sd]?|ing)\b[^.!?;:\r\n]{0,100}${LEGAL_ANTICIPATION_OBJECT_PATTERN}`,
  "iu",
);
const LEGAL_NAMED_SOURCE_ANTICIPATION_PATTERN = new RegExp(
  String.raw`\b\p{Lu}[\p{L}\p{M}'’-]{1,40}(?:\s+et\s+al\.?)?\s+anticipat(?:e[sd]?|ing)\b[^.!?;:\r\n]{0,100}(?:${LEGAL_NUMBERED_CLAIM_OBJECT_PATTERN}|${LEGAL_NUMBERED_APPLICATION_OBJECT_PATTERN})${LEGAL_TERMINAL_OBJECT_CONTINUATION_PATTERN}`,
  "u",
);
const LEGAL_STRONG_STATUS_SUBJECT_PATTERN = String.raw`(?:${LEGAL_STRONG_SUBJECT_WITH_IDENTIFIER_PATTERN}|\b(?:(?:the|this|that|these|those|each|all)\s+)?patents?(?:\s+${CLAIM_IDENTIFIER_PATTERN})?|\b(?:patent\s+)?${PATENT_PUBLICATION_ID_PATTERN}(?![\p{L}\p{M}\p{N}_]))`;
const LEGAL_STRONG_STATUS_SUBJECT_PREDICATE_PREFIX_PATTERN = `${LEGAL_STRONG_STATUS_SUBJECT_PATTERN}${LEGAL_SOURCE_QUALIFIED_SUBJECT_SUFFIX_PATTERN}${LEGAL_SUBJECT_PREDICATE_SEPARATOR_PATTERN}`;
const LEGAL_STATUS_CONTINUATION_PATTERN = String.raw`(?=\s*(?:[.,;:!?]|$)|\s+(?:(?:under|over|in\s+(?:view|light)\s+of|based\s+(?:on|upon))\s+(?:${LEGAL_ANTICIPATION_SOURCE_PATTERN}|${LEGAL_ANTICIPATION_STATUTE_PATTERN})|by\s+(?:(?:the\s+)?(?:examiner|patent\s+office|office|board|court))))`;
const LEGAL_SUBJECT_STATUS_PATTERN = new RegExp(
  `${LEGAL_STRONG_STATUS_SUBJECT_PREDICATE_PREFIX_PATTERN}${LEGAL_JUDGMENT_LINK_PATTERN}\\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}(?:invalid|valid|granted|rejected|allowable)\\b`,
  "iu",
);
const LEGAL_APPLICATION_STATUS_PATTERN = new RegExp(
  `${LEGAL_APPLICATION_SUBJECT_PREDICATE_PREFIX_PATTERN}${LEGAL_JUDGMENT_LINK_PATTERN}\\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}(?:invalid|valid|granted|rejected|allowable)\\b${LEGAL_STATUS_CONTINUATION_PATTERN}`,
  "iu",
);
const LEGAL_SUBJECT_OBVIOUSNESS_PATTERN = new RegExp(
  `${LEGAL_SUBJECT_PREDICATE_PREFIX_PATTERN}${LEGAL_JUDGMENT_LINK_PATTERN}\\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}obvious\\b`,
  "iu",
);
const LEGAL_DIFFERENCE_OBVIOUSNESS_PATTERN = new RegExp(
  String.raw`\b(?:differences?|modifications?|combinations?|substitutions?|features?)\s+${LEGAL_JUDGMENT_LINK_PATTERN}\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}obvious\b`,
  "iu",
);
const LEGAL_SOURCE_LIST_PATTERN = String.raw`${LEGAL_ANTICIPATION_SOURCE_PATTERN}(?:\s*(?:,|and|or|with)\s*${LEGAL_ANTICIPATION_SOURCE_PATTERN})+`;
const LEGAL_SOURCE_COMBINATION_OBVIOUSNESS_PATTERN = new RegExp(
  String.raw`\b(?:(?:the\s+)?(?:combination|modification|substitution|selection|use)\s+of|(?:combining|modifying|substituting|selecting|using|applying))\s+${LEGAL_SOURCE_LIST_PATTERN}\s+${LEGAL_JUDGMENT_LINK_PATTERN}\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}obvious\b`,
  "iu",
);
const LEGAL_SOURCE_OBVIOUSNESS_PATTERN = new RegExp(
  String.raw`\b${LEGAL_ANTICIPATION_SOURCE_PATTERN}(?:\s*:\s*|\s+)(?:(?:[a-z]+ly)\s+){0,3}(?:renders?|makes?)\s+[^.!?;:\r\n]{0,100}${LEGAL_CORE_REFERENCE_PATTERN}[^.!?;:\r\n]{0,40}\bobvious\b`,
  "iu",
);
const LEGAL_SKILLED_PERSON_OBVIOUSNESS_PATTERN = /\bobvious\s+to\s+(?:(?:a|the)\s+)?(?:(?:person|one)\s+(?:having\s+ordinary\s+skill|skilled)|skilled\s+(?:person|artisan)|(?:person|artisan)\s+of\s+ordinary\s+skill)\s+in\s+the\s+art\b/iu;
const LEGAL_IMPERSONAL_OBVIOUSNESS_PATTERN = new RegExp(
  String.raw`\bit\s+${LEGAL_JUDGMENT_LINK_PATTERN}\s+${LEGAL_PREDICATE_ASSESSMENT_PATTERN}obvious\b[^.!?;:\r\n]{0,120}(?:${LEGAL_ANTICIPATION_SOURCE_PATTERN}|${LEGAL_CORE_REFERENCE_PATTERN})`,
  "iu",
);
const LEGAL_DEFINITE_APPLICATION_STATUS_NOUN_PATTERN = String.raw`\b(?:the|this|that|these|those|patent)\s+applications?\b(?=\s*(?:[.,;:!?]|$)|\s+(?:is|are|was|were|has|have|would|could|should|may|might)\b)`;
const LEGAL_STATUS_NOUN_OBJECT_PATTERN = String.raw`(?:${LEGAL_CORE_REFERENCE_PATTERN}|${LEGAL_STRONG_STATUS_SUBJECT_PATTERN}|${LEGAL_DEFINITE_APPLICATION_STATUS_NOUN_PATTERN})`;
const LEGAL_STATUS_NOUN_PATTERN = new RegExp(
  String.raw`(?:\b(?:invalidity|rejection)\s+of\s+${LEGAL_STATUS_NOUN_OBJECT_PATTERN}|${LEGAL_STATUS_NOUN_OBJECT_PATTERN}\s+(?:invalidity|rejection)\b)`,
  "iu",
);
const JAPANESE_LEGAL_SUBJECT_PATTERN = String.raw`(?:(?:(?:本件|この|当該|各|本)\s*)?(?:請求項(?:\s*(?:第\s*)?\d+(?:\s*(?:、|,|及び|および|と|から|[-－–—〜～])\s*(?:第\s*)?\d+)*)?|発明|出願|特許(?:権)?)|本願)`;
const JAPANESE_LEGAL_SUBJECT_SEPARATOR_PATTERN = String.raw`\s*(?:は|が|を|について(?:は)?|に係る)\s*`;
const JAPANESE_LEGAL_SOURCE_PATTERN = String.raw`(?:[dr]\d+|${PATENT_PUBLICATION_ID_PATTERN}|引用文献\s*\d*|先行技術|文献\s*[dr]?\d+)`;
const JAPANESE_LEGAL_SOURCE_CONTEXT_PATTERN = String.raw`(?:${JAPANESE_LEGAL_SOURCE_PATTERN}\s*(?:に鑑み|に照らし|に基づき|に対して)\s*)?`;
const JAPANESE_LEGAL_ASSESSMENT_PATTERN = String.raw`(?:考えられ(?:る|ない|ます|ません|ました)|思われ(?:る|ない|ます|ません|ました)|認められ(?:る|ない|ます|ません|ました)|判断され(?:る|ない|ます|ません|ました)|判断でき(?:る|ない|ます|ません)|(?:いえ|言え)(?:る|ない|ます|ません|ました))`;
const JAPANESE_LEGAL_JUDGMENT_END_PATTERN = String.raw`(?:で(?:は)?(?:ある|ない|す|ありません)|だ|と(?:は\s*)?${JAPANESE_LEGAL_ASSESSMENT_PATTERN}|(?=[。、.!?]|$))`;
const JAPANESE_LEGAL_ADJECTIVE_STATUS_PATTERN = new RegExp(
  `${JAPANESE_LEGAL_SUBJECT_PATTERN}${JAPANESE_LEGAL_SUBJECT_SEPARATOR_PATTERN}${JAPANESE_LEGAL_SOURCE_CONTEXT_PATTERN}(?:新規|有効|無効|特許可能)${JAPANESE_LEGAL_JUDGMENT_END_PATTERN}`,
  "iu",
);
const JAPANESE_LEGAL_ACTION_STATUS_PATTERN = new RegExp(
  `${JAPANESE_LEGAL_SUBJECT_PATTERN}${JAPANESE_LEGAL_SUBJECT_SEPARATOR_PATTERN}(?:拒絶(?:され(?:る|た|ます|ました|ない|ません)?|する|した|すべき(?:で(?:は)?ある|だ)?|となる|となった|(?=[。、.!?]|$))|登録(?:され(?:る|た|ます|ました|ない|ません)?|でき(?:る|ない|ます|ません)|する|した|すべき(?:で(?:は)?ある|だ)?|可能|不可|不能))`,
  "u",
);
const JAPANESE_LEGAL_OBVIOUSNESS_PATTERN = new RegExp(
  `${JAPANESE_LEGAL_SUBJECT_PATTERN}${JAPANESE_LEGAL_SUBJECT_SEPARATOR_PATTERN}(?:${JAPANESE_LEGAL_SOURCE_PATTERN}\\s*(?:から|により|に基づき)\\s*)?(?:容易に想到でき(?:る|ない|ます|ません)|(?:容易想到|想到容易|自明|公知)${JAPANESE_LEGAL_JUDGMENT_END_PATTERN}|特許要件を満た(?:す|さない|します|しません))`,
  "iu",
);
const JAPANESE_LEGAL_PROCEDURE_PATTERN = /(?:拒絶(?:理由|査定|審決)|無効(?:理由|審判)|特許(?:権)?(?:の)?(?:登録|設定登録))/u;
const JAPANESE_LEGAL_INFRINGEMENT_PATTERN = /(?:侵害(?:あり|に当たる|と(?:なる|判断される)|のおそれ(?:がある)?|が認められる)|(?:特許権|権利|請求項)[^。\n]{0,30}侵害)/u;
const JAPANESE_STANDALONE_LEGAL_STATUS_PATTERN = /^(?:新規(?:ではない|である)?|有効|特許可能|拒絶(?:される)?|登録(?:できない|不可|不能)|無効|侵害(?:あり)?)。?$/u;
const ENGLISH_STANDALONE_LEGAL_STATUS_PATTERN = /^(?:not\s+novel|invalid|valid|rejected|allowable)\s*[.!?]?$/iu;

const STABLE_ERROR_CODES = new Set<PatentWatchErrorCode>([
  "invalid_watch_setting",
  "invalid_watch_review_status",
  "invalid_watch_run_request",
  "case_not_found",
  "watch_not_configured",
  "watch_disabled",
  "watch_claims_not_ready",
  "watch_run_in_progress",
  "watch_run_not_found",
  "watch_finding_not_found",
  "watch_corpus_unavailable",
  "watch_unavailable",
  "watch_analysis_failed",
  "watch_internal_error",
]);

const LEGAL_CONCLUSION_PATTERNS = [
  /権利化/u,
  /特許性/u,
  /新規性/u,
  /進歩性/u,
  JAPANESE_LEGAL_ADJECTIVE_STATUS_PATTERN,
  JAPANESE_LEGAL_ACTION_STATUS_PATTERN,
  JAPANESE_LEGAL_OBVIOUSNESS_PATTERN,
  JAPANESE_LEGAL_PROCEDURE_PATTERN,
  JAPANESE_LEGAL_INFRINGEMENT_PATTERN,
  JAPANESE_STANDALONE_LEGAL_STATUS_PATTERN,
  ENGLISH_STANDALONE_LEGAL_STATUS_PATTERN,
  /特許(?:権)?(?:に|と)?な(?:る|らな|り得|れな)/u,
  /特許(?:権)?[^。\n]{0,30}付与/u,
  /特許(?:を受け|取得|が成立)[^。\n]{0,160}(?:できな|できる|不可|困難|可能|しない|する)/u,
  /\b(?:patentab(?:le|ility)|unpatentable|not\s+patentable|novelty|lacks?\s+novelty|inventive\s+step|obviousness|patent\s+(?:is\s+)?invalid|infring(?:e[sd]?|ing|ement))\b/iu,
  LEGAL_SUBJECT_NOVELTY_PATTERN,
  LEGAL_APPLICATION_NOVELTY_PATTERN,
  LEGAL_SUBJECT_ANTICIPATION_PATTERN,
  LEGAL_SOURCE_ANTICIPATION_PATTERN,
  LEGAL_NAMED_SOURCE_ANTICIPATION_PATTERN,
  LEGAL_SUBJECT_STATUS_PATTERN,
  LEGAL_APPLICATION_STATUS_PATTERN,
  LEGAL_SUBJECT_OBVIOUSNESS_PATTERN,
  LEGAL_DIFFERENCE_OBVIOUSNESS_PATTERN,
  LEGAL_SOURCE_COMBINATION_OBVIOUSNESS_PATTERN,
  LEGAL_SOURCE_OBVIOUSNESS_PATTERN,
  LEGAL_SKILLED_PERSON_OBVIOUSNESS_PATTERN,
  LEGAL_IMPERSONAL_OBVIOUSNESS_PATTERN,
  LEGAL_STATUS_NOUN_PATTERN,
] as const;

const PUBLIC_ANALYSIS_FALLBACK =
  "重なり候補を整理した結果です。人による確認が必要です";

export class PatentWatchDomainError extends Error {
  readonly code: PatentWatchErrorCode;

  constructor(code: PatentWatchErrorCode) {
    super(`Patent watch operation failed: ${code}`);
    this.name = "PatentWatchDomainError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isValidPatentWatchDate(value: unknown): value is string {
  if (typeof value !== "string" || !YYYYMMDD_PATTERN.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

type PatentWatchTimestampParts = {
  epochSecond: number;
  microsecond: number;
};

function patentWatchTimestampParts(
  value: unknown,
): PatentWatchTimestampParts | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    !isValidPatentWatchDate(
      `${match[1]}${match[2]}${match[3]}`,
    ) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offset = match[8];
    const sign = offset[0] === "+" ? 1 : -1;
    const compact = offset.slice(1).replace(":", "");
    const offsetHour = Number(compact.slice(0, 2));
    const offsetMinute = compact.length === 2 ? 0 : Number(compact.slice(2));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const utcMillis = date.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(utcMillis)) return null;

  return {
    epochSecond: Math.trunc(utcMillis / 1_000),
    microsecond: Number((match[7] ?? "").padEnd(6, "0")),
  };
}

export function isValidPatentWatchTimestamp(value: unknown): value is string {
  return patentWatchTimestampParts(value) !== null;
}

export function comparePatentWatchTimestamps(
  left: string,
  right: string,
): number {
  const leftParts = patentWatchTimestampParts(left);
  const rightParts = patentWatchTimestampParts(right);
  if (leftParts === null || rightParts === null) {
    throw new PatentWatchDomainError("watch_unavailable");
  }
  if (leftParts.epochSecond !== rightParts.epochSecond) {
    return leftParts.epochSecond < rightParts.epochSecond ? -1 : 1;
  }
  if (leftParts.microsecond === rightParts.microsecond) return 0;
  return leftParts.microsecond < rightParts.microsecond ? -1 : 1;
}

export function validatePatentWatchSettingInput(
  value: unknown,
): PatentWatchSettingInput {
  if (!isRecord(value)) {
    throw new PatentWatchDomainError("invalid_watch_setting");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("enabled") ||
    !keys.includes("monitoringFromDate") ||
    typeof value.enabled !== "boolean" ||
    !isValidPatentWatchDate(value.monitoringFromDate)
  ) {
    throw new PatentWatchDomainError("invalid_watch_setting");
  }
  return {
    enabled: value.enabled,
    monitoringFromDate: value.monitoringFromDate,
  };
}

export function parsePatentWatchCursor(
  runUpdatedAt: unknown,
  importId: unknown,
): PatentWatchCursor | null {
  if (runUpdatedAt === null && importId === null) return null;
  if (
    typeof runUpdatedAt !== "string" ||
    !isValidPatentWatchTimestamp(runUpdatedAt) ||
    !isPositiveSafeInteger(importId)
  ) {
    throw new PatentWatchDomainError("watch_unavailable");
  }
  return { runUpdatedAt, importId };
}

export function comparePatentWatchCursors(
  left: PatentWatchCursor,
  right: PatentWatchCursor,
): number {
  const timestampComparison = comparePatentWatchTimestamps(
    left.runUpdatedAt,
    right.runUpdatedAt,
  );
  if (timestampComparison !== 0) return timestampComparison;
  return left.importId - right.importId;
}

export function canonicalSourceIdentityJson(
  publicationNumber: string,
  contentSha256: string,
): string {
  if (
    publicationNumber.length === 0 ||
    publicationNumber.trim() !== publicationNumber ||
    !SHA256_PATTERN.test(contentSha256)
  ) {
    throw new PatentWatchDomainError("watch_corpus_unavailable");
  }
  return JSON.stringify({ publicationNumber, contentSha256 });
}

export function createPatentWatchSourceKey(
  publicationNumber: string,
  contentSha256: string,
): string {
  return createHash("sha256")
    .update(
      canonicalSourceIdentityJson(publicationNumber, contentSha256),
      "utf8",
    )
    .digest("hex");
}

export function validatePatentWatchReviewInput(value: unknown): {
  reviewStatus: PatentWatchReviewStatus;
} {
  if (!isRecord(value)) {
    throw new PatentWatchDomainError("invalid_watch_review_status");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== "reviewStatus" ||
    !REVIEW_STATUSES.has(value.reviewStatus as PatentWatchReviewStatus)
  ) {
    throw new PatentWatchDomainError("invalid_watch_review_status");
  }
  return { reviewStatus: value.reviewStatus as PatentWatchReviewStatus };
}

export function validatePatentWatchRunRequestBody(
  value: string | Uint8Array | ArrayBuffer | null | undefined,
): void {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.length === 0) ||
    (value instanceof Uint8Array && value.byteLength === 0) ||
    (value instanceof ArrayBuffer && value.byteLength === 0)
  ) {
    return;
  }
  throw new PatentWatchDomainError("invalid_watch_run_request");
}

export function isPatentWatchErrorCode(
  value: unknown,
): value is PatentWatchErrorCode {
  return (
    typeof value === "string" &&
    STABLE_ERROR_CODES.has(value as PatentWatchErrorCode)
  );
}

export function stablePatentWatchErrorCode(
  error: unknown,
): PatentWatchErrorCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isPatentWatchErrorCode(error.code)
  ) {
    return error.code;
  }
  return "watch_internal_error";
}

export function containsLegalConclusion(value: string): boolean {
  const normalizedValue = value.normalize("NFKC").replace(/\p{Cf}+/gu, "");
  return LEGAL_CONCLUSION_PATTERNS.some((pattern) =>
    pattern.test(normalizedValue),
  );
}

const PUBLIC_TEXT_TOKEN_PATTERN = /[^\s<>"']+/gu;
const CREDENTIAL_QUERY_KEY_NAME_PATTERN = String.raw`(?:x-amz-signature|x-goog-signature|x-amz-security-token|access[_-]?token|id[_-]?token|refresh[_-]?token|subscription[_-]?key|ocp-apim-subscription-key|x[_-]api[_-]key|api[_-]?key|apikey|client[_-]?secret|account[_-]?key|shared[_-]?access[_-]?key)`;
const CREDENTIAL_ASSIGNMENT_KEY_NAME_PATTERN = String.raw`(?:x-amz-signature|x-goog-signature|x-amz-security-token|access[_-]?token|id[_-]?token|refresh[_-]?token|subscription[_-]?key|ocp-apim-subscription-key|x[_-]api[_-]key|api[_-]?key|apikey|client[_-]?secret|account[_-]?key|shared[_-]?access[_-]?key|storage[_-]?account[_-]?key|password|secret|connection[_-]?string|(?:proxy[-_ ]?)?authorization)`;
const CREDENTIAL_PARAMETER_PATTERN = new RegExp(
  String.raw`(?:(?:^|[?&#;])${CREDENTIAL_QUERY_KEY_NAME_PATTERN}=|[?&#;](?:sig|signature|token|key)=|[?&#;](?:code|auth)=[a-z0-9._~+/%=-]{8,}(?=$|[&#;)\]},>。、，]))`,
  "iu",
);
const CREDENTIAL_ASSIGNMENT_VALUE_PATTERN = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|\x60[^\x60\r\n]*\x60|[^\s,]+)`;
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}_/.-])\x60?(?:${CREDENTIAL_ASSIGNMENT_KEY_NAME_PATTERN}|(?:[a-z0-9]+_)+(?:api_key|key|token|password|secret|connection_string))\x60?\s*[:=]\s*${CREDENTIAL_ASSIGNMENT_VALUE_PATTERN}`,
  "giu",
);
const JSON_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\\?["'](?:${CREDENTIAL_ASSIGNMENT_KEY_NAME_PATTERN}|token)\\?["']\s*:\s*\\?["'][^\r\n]*?\\?["']`,
  "giu",
);
const AUTHORIZATION_HEADER_PATTERN =
  /(?<![\p{L}\p{M}\p{N}_/.-])(?:proxy[-_ ]?)?authorization\s*:\s*[^\r\n|]+/giu;
const UPPERCASE_TOKEN_ASSIGNMENT_PATTERN =
  /(?<![\p{L}\p{M}\p{N}_/.-])TOKEN\s*[:=]\s*[^\s,]+/gu;
const PERCENT_ESCAPE_RUN_PATTERN = /(?:%[0-9a-f]{2})+/giu;
const MAX_CREDENTIAL_DECODE_PASSES = 2;

function normalizeCredentialCandidate(value: string): string {
  return value.normalize("NFKC").replace(/\p{Cf}+/gu, "");
}

function decodePercentEscapeRuns(value: string): string {
  return value.replace(PERCENT_ESCAPE_RUN_PATTERN, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function hasCredentialParameter(value: string): boolean {
  let candidate = normalizeCredentialCandidate(value);
  for (let pass = 0; pass <= MAX_CREDENTIAL_DECODE_PASSES; pass += 1) {
    if (CREDENTIAL_PARAMETER_PATTERN.test(candidate)) return true;
    if (pass === MAX_CREDENTIAL_DECODE_PASSES) break;
    const decoded = normalizeCredentialCandidate(
      decodePercentEscapeRuns(candidate),
    );
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return false;
}

function redactCredentialBearingTokens(value: string): string {
  return value.replace(PUBLIC_TEXT_TOKEN_PATTERN, (token) =>
    hasCredentialParameter(token) ? "[非表示]" : token,
  );
}

function containsCredentialAssignment(value: string): boolean {
  const redacted = value
    .replace(JSON_CREDENTIAL_ASSIGNMENT_PATTERN, "[非表示]")
    .replace(AUTHORIZATION_HEADER_PATTERN, "[非表示]")
    .replace(UPPERCASE_TOKEN_ASSIGNMENT_PATTERN, "[非表示]")
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "[非表示]");
  return redacted !== value;
}

function redactNormalizedCredentialSegments(value: string): string {
  return value.replace(/[^\r\n|]+/gu, (segment) => {
    const normalizedSegment = normalizeCredentialCandidate(segment);
    return normalizedSegment !== segment &&
      containsCredentialAssignment(normalizedSegment)
      ? "[非表示]"
      : segment;
  });
}

/** 公開レスポンスやreportへ内部識別子・local pathを持ち込まない。 */
export function sanitizePatentWatchPublicText(value: string): string {
  return redactCredentialBearingTokens(redactNormalizedCredentialSegments(value))
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/giu, "[非表示]")
    .replace(/\bfile:\/\/[^\s,;]*/giu, "[非表示]")
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n,;|]*/gu, "[非表示]")
    .replace(/\\\\[^\\/\r\n,;|]+[\\/][^\r\n,;|]*/gu, "[非表示]")
    .replace(
      /\/(?:home|Users|tmp|var|private|opt|mnt|root|app|workspace|etc|srv|usr)\/[^\s,;]*/gu,
      "[非表示]",
    )
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s@]+@[^\s]+/giu,
      "[非表示]",
    )
    .replace(JSON_CREDENTIAL_ASSIGNMENT_PATTERN, "[非表示]")
    .replace(AUTHORIZATION_HEADER_PATTERN, "[非表示]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[非表示]")
    .replace(UPPERCASE_TOKEN_ASSIGNMENT_PATTERN, "[非表示]")
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "[非表示]");
}

export function boundedPatentWatchPublicText(
  value: string,
  maxCharacters: number,
): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new PatentWatchDomainError("watch_internal_error");
  }
  return Array.from(sanitizePatentWatchPublicText(value))
    .slice(0, maxCharacters)
    .join("");
}

function normalizeSensitiveText(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactSensitiveText(value: string): string {
  return normalizeSensitiveText(value).replace(
    /[\p{White_Space}\p{P}\p{S}\p{Cf}\p{Cc}]+/gu,
    "",
  );
}

function containsForbiddenFullText(
  value: string,
  forbiddenFullTexts: readonly string[],
): boolean {
  const compactValue = compactSensitiveText(value);
  if (compactValue.length === 0) return false;
  return forbiddenFullTexts.some((forbidden) => {
    const compactForbidden = compactSensitiveText(forbidden);
    return (
      compactForbidden.length > 0 && compactValue.includes(compactForbidden)
    );
  });
}

function containsForbiddenAggregate(
  values: readonly string[],
  forbiddenFullTexts: readonly string[],
): boolean {
  const compactAggregate = compactSensitiveText(values.join(""));
  if (compactAggregate.length === 0) return false;
  return forbiddenFullTexts.some((forbidden) => {
    const compactForbidden = compactSensitiveText(forbidden);
    return (
      compactForbidden.length > 0 &&
      compactAggregate.includes(compactForbidden)
    );
  });
}

function safeAnalysisList(
  values: readonly string[],
  forbiddenFullTexts: readonly string[],
): string[] {
  return values
    .filter(
      (value) =>
        !containsLegalConclusion(value) &&
        !containsForbiddenFullText(value, forbiddenFullTexts),
    )
    .map((value) => sanitizePatentWatchPublicText(value).trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((value) => Array.from(value).slice(0, 500).join(""));
}

export function sanitizePatentWatchAnalysis(
  value: PatentWatchAnalysisJson,
  forbiddenFullTexts: readonly string[] = [],
): PatentWatchAnalysisJson {
  const explanation =
    containsLegalConclusion(value.explanation) ||
    containsForbiddenFullText(value.explanation, forbiddenFullTexts)
    ? PUBLIC_ANALYSIS_FALLBACK
    : sanitizePatentWatchPublicText(value.explanation).trim();
  const matchedElements = safeAnalysisList(
    value.matchedElements,
    forbiddenFullTexts,
  );
  const unmatchedElements = safeAnalysisList(
    value.unmatchedElements,
    forbiddenFullTexts,
  );
  const safeExplanation =
    Array.from(explanation).slice(0, 2_000).join("") ||
    PUBLIC_ANALYSIS_FALLBACK;
  if (
    containsForbiddenAggregate(
      [...matchedElements, ...unmatchedElements, safeExplanation],
      forbiddenFullTexts,
    )
  ) {
    return {
      matchedElements: [],
      unmatchedElements: [],
      explanation: PUBLIC_ANALYSIS_FALLBACK,
    };
  }
  return {
    matchedElements,
    unmatchedElements,
    explanation: safeExplanation,
  };
}

export function serializePatentWatchAnalysis(
  value: PatentWatchAnalysisJson,
  forbiddenFullTexts: readonly string[] = [],
): string {
  const safe = sanitizePatentWatchAnalysis(value, forbiddenFullTexts);
  return JSON.stringify({
    matchedElements: safe.matchedElements,
    unmatchedElements: safe.unmatchedElements,
    explanation: safe.explanation,
  });
}
