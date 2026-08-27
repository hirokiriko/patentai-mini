import { createHash } from "node:crypto";
import type {
  KohoPackageCountSummary,
  KohoPackageSection,
} from "../koho-package";
import type {
  KohoDocumentKind,
  KohoIngestStatus,
  KohoIssueCode,
} from "../koho-xml";
import { inspectKohoEntryPath } from "../koho-xml/path";
import {
  KohoImportPlanValidationError,
  type KohoImportDocumentKind,
  type KohoImportDocumentPlan,
  type KohoImportPlan,
  type KohoImportPlanValidationErrorCode,
} from "./types";

export type KohoImportRunContract = Omit<KohoImportPlan, "documents">;
export type KohoImportDocumentPayload = Omit<
  KohoImportDocumentPlan,
  "contentSha256"
>;

export interface KohoImportRunIssueAggregate {
  source: "package" | "xml";
  code: string;
  status: Exclude<KohoIngestStatus, "success">;
  kind: KohoDocumentKind | null;
  section: KohoPackageSection | null;
  count: number;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_TYPES: ReadonlySet<string> = new Set(["JPA", "JPB"]);
const PACKAGE_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "review_required",
  "failed",
]);
const DOCUMENT_PARSE_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "review_required",
]);
const DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "A1",
  "P1",
  "B1",
  "B2",
]);
const ALL_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "A1",
  "A5",
  "P1",
  "P5",
  "B1",
  "B2",
]);
const ISSUE_STATUSES: ReadonlySet<string> = new Set([
  "review_required",
  "unsupported_type",
  "failed",
]);
const CLASSIFICATION_ROLES: ReadonlySet<string> = new Set([
  "main",
  "further",
]);
const ROLES = [
  "directory",
  "xml",
  "csv",
  "schema",
  "image",
  "other",
] as const;
const SECTIONS = ["P_A1", "P_A5", "P_P1", "P_P5", "P_B1"] as const;
const SECTION_SET: ReadonlySet<string> = new Set(SECTIONS);

const KOHO_ISSUE_CODE_FLAGS: Record<KohoIssueCode, true> = {
  invalid_limits: true,
  unsafe_entry_path: true,
  xml_byte_limit_exceeded: true,
  xml_depth_limit_exceeded: true,
  xml_element_limit_exceeded: true,
  xml_text_limit_exceeded: true,
  doctype_forbidden: true,
  malformed_xml: true,
  invalid_utf8: true,
  unknown_named_entity: true,
  unknown_root: true,
  unknown_namespace: true,
  root_path_mismatch: true,
  package_type_mismatch: true,
  kind_mismatch: true,
  index_hint_missing: true,
  schema_mismatch: true,
  version_mismatch: true,
  publication_number_mismatch: true,
  publication_date_mismatch: true,
  cardinality_mismatch: true,
  required_field_missing: true,
  invalid_date: true,
  claims_missing: true,
  applicant_name_missing: true,
  optional_classification_missing: true,
  optional_abstract_missing: true,
  unsafe_reference_target: true,
  unknown_inline_element: true,
};
const KOHO_ISSUE_CODES: ReadonlySet<string> = new Set(
  Object.keys(KOHO_ISSUE_CODE_FLAGS),
);

const PLAN_KEYS = [
  "packageType",
  "sourceSha256",
  "packageStatus",
  "documentCount",
  "amendmentCount",
  "nestedSt26Count",
  "countsJson",
  "issuesJson",
  "documents",
] as const;
const RUN_KEYS = PLAN_KEYS.filter((key) => key !== "documents");
const DOCUMENT_PAYLOAD_KEYS = [
  "normalizedEntryPath",
  "parseStatus",
  "kind",
  "publicationNumber",
  "applicationNumber",
  "publicationDate",
  "registrationNumber",
  "registrationDate",
  "inventionTitle",
  "abstractText",
  "claimsText",
  "applicantsJson",
  "ipcJson",
  "fiJson",
  "parseIssuesJson",
  "sourceMetadataJson",
] as const;
const DOCUMENT_KEYS = [...DOCUMENT_PAYLOAD_KEYS, "contentSha256"] as const;

type JsonRecord = Record<string, unknown>;
type Role = (typeof ROLES)[number];
type Section = (typeof SECTIONS)[number];
type RoleCounts = Record<Role, number>;

interface CanonicalSectionCounts {
  primaryXmlCandidates: number;
  finalXmlResults: number;
  confirmedFullPublications: number;
  confirmedAmendments: number;
  documentFolders: number;
  contents1Records: number;
  contents2Records: number;
  attachmentCount: number;
  roleCounts: RoleCounts;
}

interface CanonicalCounts {
  primaryXmlCandidates: number;
  finalXmlResults: number;
  confirmedFullPublications: number;
  confirmedAmendments: number;
  nestedXmlCandidates: number;
  documentFolders: number;
  documentListRecords: number;
  roleCounts: RoleCounts;
  bySection: Record<Section, CanonicalSectionCounts>;
}

function invalid(code: KohoImportPlanValidationErrorCode): never {
  throw new KohoImportPlanValidationError(code);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: KohoImportPlanValidationErrorCode,
): JsonRecord {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      invalid(code);
    }

    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      invalid(code);
    }

    const snapshot: JsonRecord = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalid(code);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    invalid(code);
  }
}

function exactArray(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      invalid(code);
    }
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      keys.length !== lengthDescriptor.value + 1 ||
      !keys.includes("length")
    ) {
      invalid(code);
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalid(code);
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    invalid(code);
  }
}

function stringValue(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): string {
  if (typeof value !== "string") invalid(code);
  return value;
}

function nullableStringValue(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): string | null {
  if (value !== null && typeof value !== "string") invalid(code);
  return value as string | null;
}

function booleanOrNullValue(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): boolean | null {
  if (value !== null && typeof value !== "boolean") invalid(code);
  return value as boolean | null;
}

function nonNegativeInteger(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(code);
  return value as number;
}

function positiveInteger(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(code);
  return value as number;
}

function enumString<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  code: KohoImportPlanValidationErrorCode,
): T {
  if (typeof value !== "string" || !allowed.has(value)) invalid(code);
  return value as T;
}

function parseCanonicalJson<T>(
  text: unknown,
  code: KohoImportPlanValidationErrorCode,
  project: (value: unknown) => T,
): T {
  if (typeof text !== "string") invalid(code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid(code);
  }
  const canonical = project(parsed);
  if (JSON.stringify(canonical) !== text) invalid(code);
  return canonical;
}

function serializeCanonicalJson<T>(
  value: unknown,
  project: (candidate: unknown) => T,
): string {
  return JSON.stringify(project(value));
}

function projectRoleCounts(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): RoleCounts {
  const record = exactRecord(value, ROLES, code);
  return {
    directory: nonNegativeInteger(record.directory, code),
    xml: nonNegativeInteger(record.xml, code),
    csv: nonNegativeInteger(record.csv, code),
    schema: nonNegativeInteger(record.schema, code),
    image: nonNegativeInteger(record.image, code),
    other: nonNegativeInteger(record.other, code),
  };
}

function projectSectionCounts(
  value: unknown,
  code: KohoImportPlanValidationErrorCode,
): CanonicalSectionCounts {
  const keys = [
    "primaryXmlCandidates",
    "finalXmlResults",
    "confirmedFullPublications",
    "confirmedAmendments",
    "documentFolders",
    "contents1Records",
    "contents2Records",
    "attachmentCount",
    "roleCounts",
  ] as const;
  const record = exactRecord(value, keys, code);
  return {
    primaryXmlCandidates: nonNegativeInteger(record.primaryXmlCandidates, code),
    finalXmlResults: nonNegativeInteger(record.finalXmlResults, code),
    confirmedFullPublications: nonNegativeInteger(
      record.confirmedFullPublications,
      code,
    ),
    confirmedAmendments: nonNegativeInteger(record.confirmedAmendments, code),
    documentFolders: nonNegativeInteger(record.documentFolders, code),
    contents1Records: nonNegativeInteger(record.contents1Records, code),
    contents2Records: nonNegativeInteger(record.contents2Records, code),
    attachmentCount: nonNegativeInteger(record.attachmentCount, code),
    roleCounts: projectRoleCounts(record.roleCounts, code),
  };
}

function projectCounts(value: unknown): CanonicalCounts {
  const code = "invalid_counts_json" as const;
  const keys = [
    "primaryXmlCandidates",
    "finalXmlResults",
    "confirmedFullPublications",
    "confirmedAmendments",
    "nestedXmlCandidates",
    "documentFolders",
    "documentListRecords",
    "roleCounts",
    "bySection",
  ] as const;
  const record = exactRecord(value, keys, code);
  const bySection = exactRecord(record.bySection, SECTIONS, code);
  return {
    primaryXmlCandidates: nonNegativeInteger(record.primaryXmlCandidates, code),
    finalXmlResults: nonNegativeInteger(record.finalXmlResults, code),
    confirmedFullPublications: nonNegativeInteger(
      record.confirmedFullPublications,
      code,
    ),
    confirmedAmendments: nonNegativeInteger(record.confirmedAmendments, code),
    nestedXmlCandidates: nonNegativeInteger(record.nestedXmlCandidates, code),
    documentFolders: nonNegativeInteger(record.documentFolders, code),
    documentListRecords: nonNegativeInteger(record.documentListRecords, code),
    roleCounts: projectRoleCounts(record.roleCounts, code),
    bySection: {
      P_A1: projectSectionCounts(bySection.P_A1, code),
      P_A5: projectSectionCounts(bySection.P_A5, code),
      P_P1: projectSectionCounts(bySection.P_P1, code),
      P_P5: projectSectionCounts(bySection.P_P5, code),
      P_B1: projectSectionCounts(bySection.P_B1, code),
    },
  };
}

export function serializeKohoImportCountsJson(
  counts: KohoPackageCountSummary,
): string {
  return serializeCanonicalJson(counts, projectCounts);
}

function assertCountsJson(
  text: unknown,
  expected: Pick<
    KohoImportRunContract,
    "documentCount" | "amendmentCount" | "nestedSt26Count"
  >,
): void {
  const counts = parseCanonicalJson(text, "invalid_counts_json", projectCounts);
  if (
    counts.confirmedFullPublications !== expected.documentCount ||
    counts.confirmedAmendments !== expected.amendmentCount ||
    counts.nestedXmlCandidates !== expected.nestedSt26Count
  ) {
    invalid("invalid_counts_json");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableText(
  left: string | null,
  right: string | null,
): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareText(left, right);
}

function compareIssues(
  left: KohoImportRunIssueAggregate,
  right: KohoImportRunIssueAggregate,
): number {
  return (
    compareText(left.source, right.source) ||
    compareText(left.code, right.code) ||
    compareText(left.status, right.status) ||
    compareNullableText(left.kind, right.kind) ||
    compareNullableText(left.section, right.section)
  );
}

function projectIssue(value: unknown): KohoImportRunIssueAggregate {
  const code = "invalid_issues_json" as const;
  const record = exactRecord(
    value,
    ["source", "code", "status", "kind", "section", "count"],
    code,
  );
  const source = enumString<"package" | "xml">(
    record.source,
    new Set(["package", "xml"]),
    code,
  );
  const kind =
    record.kind === null
      ? null
      : enumString<KohoDocumentKind>(record.kind, ALL_DOCUMENT_KINDS, code);
  const section =
    record.section === null
      ? null
      : enumString<KohoPackageSection>(record.section, SECTION_SET, code);
  if (
    (source === "package" && kind !== null) ||
    (source === "xml" && section !== null)
  ) {
    invalid(code);
  }
  return {
    source,
    code: stringValue(record.code, code),
    status: enumString(record.status, ISSUE_STATUSES, code),
    kind,
    section,
    count: positiveInteger(record.count, code),
  };
}

function projectIssues(value: unknown, requireSorted: boolean): KohoImportRunIssueAggregate[] {
  const code = "invalid_issues_json" as const;
  const items = exactArray(value, code).map(projectIssue);
  if (!requireSorted) items.sort(compareIssues);
  for (let index = 1; index < items.length; index += 1) {
    if (compareIssues(items[index - 1], items[index]) >= 0) invalid(code);
  }
  return items;
}

export function serializeKohoImportIssuesJson(
  issues: KohoImportRunIssueAggregate[],
): string {
  return JSON.stringify(projectIssues(issues, false));
}

function assertIssuesJson(text: unknown): void {
  parseCanonicalJson(text, "invalid_issues_json", (value) =>
    projectIssues(value, true),
  );
}

function projectApplicants(value: unknown) {
  const code = "invalid_applicants_json" as const;
  return exactArray(value, code).map((candidate) => {
    const applicant = exactRecord(
      candidate,
      ["ordinal", "sequenceNumber", "names"],
      code,
    );
    return {
      ordinal: nonNegativeInteger(applicant.ordinal, code),
      sequenceNumber: nullableStringValue(applicant.sequenceNumber, code),
      names: exactArray(applicant.names, code).map((nameCandidate) => {
        const name = exactRecord(
          nameCandidate,
          ["value", "sourceValue", "originalLanguageIndicator"],
          code,
        );
        return {
          value: stringValue(name.value, code),
          sourceValue: stringValue(name.sourceValue, code),
          originalLanguageIndicator: booleanOrNullValue(
            name.originalLanguageIndicator,
            code,
          ),
        };
      }),
    };
  });
}

export function serializeKohoImportApplicantsJson(value: unknown): string {
  return serializeCanonicalJson(value, projectApplicants);
}

function projectClassifications(
  value: unknown,
  code: "invalid_ipc_json" | "invalid_fi_json",
) {
  return exactArray(value, code).map((candidate) => {
    const classification = exactRecord(
      candidate,
      ["ordinal", "role", "value", "sourceValue"],
      code,
    );
    return {
      ordinal: nonNegativeInteger(classification.ordinal, code),
      role: enumString<"main" | "further">(
        classification.role,
        CLASSIFICATION_ROLES,
        code,
      ),
      value: stringValue(classification.value, code),
      sourceValue: stringValue(classification.sourceValue, code),
    };
  });
}

export function serializeKohoImportIpcJson(value: unknown): string {
  return serializeCanonicalJson(value, (candidate) =>
    projectClassifications(candidate, "invalid_ipc_json"),
  );
}

export function serializeKohoImportFiJson(value: unknown): string {
  return serializeCanonicalJson(value, (candidate) =>
    projectClassifications(candidate, "invalid_fi_json"),
  );
}

function projectParseIssues(value: unknown) {
  const code = "invalid_parse_issues_json" as const;
  return exactArray(value, code).map((candidate) => {
    const issue = exactRecord(candidate, ["code", "status", "field"], code);
    return {
      code: enumString<KohoIssueCode>(issue.code, KOHO_ISSUE_CODES, code),
      status: enumString<Exclude<KohoIngestStatus, "success">>(
        issue.status,
        ISSUE_STATUSES,
        code,
      ),
      field: nullableStringValue(issue.field, code),
    };
  });
}

export function serializeKohoImportParseIssuesJson(value: unknown): string {
  return serializeCanonicalJson(value, projectParseIssues);
}

interface CanonicalSourceMetadata {
  normalizedEntryPath: string;
  rootLocalName: string | null;
  rootNamespaceUri: string | null;
  schemaBasename: string | null;
  st96Version: string | null;
  ipoVersion: string | null;
  languageCode: string | null;
  xsdValidation: "not_performed";
}

function projectSourceMetadata(value: unknown): CanonicalSourceMetadata {
  const code = "invalid_source_metadata_json" as const;
  const source = exactRecord(
    value,
    [
      "normalizedEntryPath",
      "rootLocalName",
      "rootNamespaceUri",
      "schemaBasename",
      "st96Version",
      "ipoVersion",
      "languageCode",
      "xsdValidation",
    ],
    code,
  );
  if (source.xsdValidation !== "not_performed") invalid(code);
  return {
    normalizedEntryPath: stringValue(source.normalizedEntryPath, code),
    rootLocalName: nullableStringValue(source.rootLocalName, code),
    rootNamespaceUri: nullableStringValue(source.rootNamespaceUri, code),
    schemaBasename: nullableStringValue(source.schemaBasename, code),
    st96Version: nullableStringValue(source.st96Version, code),
    ipoVersion: nullableStringValue(source.ipoVersion, code),
    languageCode: nullableStringValue(source.languageCode, code),
    xsdValidation: "not_performed",
  };
}

export function serializeKohoImportSourceMetadataJson(value: unknown): string {
  return serializeCanonicalJson(value, projectSourceMetadata);
}

function assertPackageType(value: unknown): asserts value is KohoImportPlan["packageType"] {
  enumString(value, PACKAGE_TYPES, "invalid_package_type");
}

function assertPackageStatus(
  value: unknown,
): asserts value is KohoImportPlan["packageStatus"] {
  enumString(value, PACKAGE_STATUSES, "invalid_package_status");
}

function assertSourceSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid("invalid_source_sha256");
  }
}

function assertContentSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid("invalid_content_sha256");
  }
}

function assertDocumentPath(
  value: unknown,
  kind: KohoImportDocumentKind,
  packageType?: KohoImportPlan["packageType"],
): asserts value is string {
  if (typeof value !== "string") invalid("invalid_normalized_entry_path");
  const inspected = inspectKohoEntryPath(value);
  const expectedSection =
    kind === "A1" ? "P_A1" : kind === "P1" ? "P_P1" : "P_B1";
  if (
    !inspected.ok ||
    inspected.normalizedPath !== value ||
    !inspected.isPrimaryXml ||
    inspected.section !== expectedSection ||
    (packageType === "JPA" && kind !== "A1" && kind !== "P1") ||
    (packageType === "JPB" && kind !== "B1" && kind !== "B2")
  ) {
    invalid("invalid_normalized_entry_path");
  }
}

function projectDocumentPayload(
  value: unknown,
  packageType?: KohoImportPlan["packageType"],
): KohoImportDocumentPayload {
  const document = exactRecord(
    value,
    DOCUMENT_PAYLOAD_KEYS,
    "invalid_document_shape",
  );
  const parseStatus = enumString<KohoImportDocumentPlan["parseStatus"]>(
    document.parseStatus,
    DOCUMENT_PARSE_STATUSES,
    "invalid_document_status",
  );
  const kind = enumString<KohoImportDocumentKind>(
    document.kind,
    DOCUMENT_KINDS,
    "invalid_document_kind",
  );
  assertDocumentPath(document.normalizedEntryPath, kind, packageType);

  const applicantsJson = stringValue(
    document.applicantsJson,
    "invalid_applicants_json",
  );
  parseCanonicalJson(
    applicantsJson,
    "invalid_applicants_json",
    projectApplicants,
  );
  const ipcJson = stringValue(document.ipcJson, "invalid_ipc_json");
  parseCanonicalJson(ipcJson, "invalid_ipc_json", (candidate) =>
    projectClassifications(candidate, "invalid_ipc_json"),
  );
  const fiJson = stringValue(document.fiJson, "invalid_fi_json");
  parseCanonicalJson(fiJson, "invalid_fi_json", (candidate) =>
    projectClassifications(candidate, "invalid_fi_json"),
  );
  const parseIssuesJson = stringValue(
    document.parseIssuesJson,
    "invalid_parse_issues_json",
  );
  parseCanonicalJson(
    parseIssuesJson,
    "invalid_parse_issues_json",
    projectParseIssues,
  );
  const sourceMetadataJson = stringValue(
    document.sourceMetadataJson,
    "invalid_source_metadata_json",
  );
  const sourceMetadata = parseCanonicalJson(
    sourceMetadataJson,
    "invalid_source_metadata_json",
    projectSourceMetadata,
  );
  if (sourceMetadata.normalizedEntryPath !== document.normalizedEntryPath) {
    invalid("inconsistent_source_metadata");
  }

  return {
    normalizedEntryPath: document.normalizedEntryPath,
    parseStatus,
    kind,
    publicationNumber: stringValue(
      document.publicationNumber,
      "invalid_document_shape",
    ),
    applicationNumber: stringValue(
      document.applicationNumber,
      "invalid_document_shape",
    ),
    publicationDate: stringValue(
      document.publicationDate,
      "invalid_document_shape",
    ),
    registrationNumber: nullableStringValue(
      document.registrationNumber,
      "invalid_document_shape",
    ),
    registrationDate: nullableStringValue(
      document.registrationDate,
      "invalid_document_shape",
    ),
    inventionTitle: stringValue(
      document.inventionTitle,
      "invalid_document_shape",
    ),
    abstractText: nullableStringValue(
      document.abstractText,
      "invalid_document_shape",
    ),
    claimsText: stringValue(document.claimsText, "invalid_document_shape"),
    applicantsJson,
    ipcJson,
    fiJson,
    parseIssuesJson,
    sourceMetadataJson,
  };
}

export function computeKohoImportDocumentContentSha256(
  payload: KohoImportDocumentPayload,
): string {
  const canonicalPayload = {
    normalizedEntryPath: payload.normalizedEntryPath,
    parseStatus: payload.parseStatus,
    kind: payload.kind,
    publicationNumber: payload.publicationNumber,
    applicationNumber: payload.applicationNumber,
    publicationDate: payload.publicationDate,
    registrationNumber: payload.registrationNumber,
    registrationDate: payload.registrationDate,
    inventionTitle: payload.inventionTitle,
    abstractText: payload.abstractText,
    claimsText: payload.claimsText,
    applicantsJson: payload.applicantsJson,
    ipcJson: payload.ipcJson,
    fiJson: payload.fiJson,
    parseIssuesJson: payload.parseIssuesJson,
    sourceMetadataJson: payload.sourceMetadataJson,
  };
  return createHash("sha256")
    .update(Buffer.from(JSON.stringify(canonicalPayload), "utf8"))
    .digest("hex");
}

export function createKohoImportDocumentPlan(
  value: KohoImportDocumentPayload,
): KohoImportDocumentPlan {
  const payload = projectDocumentPayload(value);
  return {
    ...payload,
    contentSha256: computeKohoImportDocumentContentSha256(payload),
  };
}

function projectKohoImportDocumentPlan(
  value: unknown,
  packageType?: KohoImportPlan["packageType"],
): KohoImportDocumentPlan {
  const document = exactRecord(value, DOCUMENT_KEYS, "invalid_document_shape");
  assertContentSha256(document.contentSha256);
  const payload = projectDocumentPayload(
    {
      normalizedEntryPath: document.normalizedEntryPath,
      parseStatus: document.parseStatus,
      kind: document.kind,
      publicationNumber: document.publicationNumber,
      applicationNumber: document.applicationNumber,
      publicationDate: document.publicationDate,
      registrationNumber: document.registrationNumber,
      registrationDate: document.registrationDate,
      inventionTitle: document.inventionTitle,
      abstractText: document.abstractText,
      claimsText: document.claimsText,
      applicantsJson: document.applicantsJson,
      ipcJson: document.ipcJson,
      fiJson: document.fiJson,
      parseIssuesJson: document.parseIssuesJson,
      sourceMetadataJson: document.sourceMetadataJson,
    },
    packageType,
  );
  if (
    computeKohoImportDocumentContentSha256(payload) !== document.contentSha256
  ) {
    invalid("content_sha256_mismatch");
  }
  return { ...payload, contentSha256: document.contentSha256 };
}

export function assertKohoImportDocumentPlan(
  value: unknown,
  packageType?: KohoImportPlan["packageType"],
): asserts value is KohoImportDocumentPlan {
  projectKohoImportDocumentPlan(value, packageType);
}

function projectKohoImportRunContract(
  value: unknown,
): KohoImportRunContract {
  const run = exactRecord(value, RUN_KEYS, "invalid_plan_shape");
  assertPackageType(run.packageType);
  assertSourceSha256(run.sourceSha256);
  assertPackageStatus(run.packageStatus);
  const documentCount = nonNegativeInteger(
    run.documentCount,
    "invalid_document_count",
  );
  const amendmentCount = nonNegativeInteger(
    run.amendmentCount,
    "invalid_document_count",
  );
  const nestedSt26Count = nonNegativeInteger(
    run.nestedSt26Count,
    "invalid_document_count",
  );
  assertCountsJson(run.countsJson, {
    documentCount,
    amendmentCount,
    nestedSt26Count,
  });
  assertIssuesJson(run.issuesJson);
  return {
    packageType: run.packageType,
    sourceSha256: run.sourceSha256,
    packageStatus: run.packageStatus,
    documentCount,
    amendmentCount,
    nestedSt26Count,
    countsJson: run.countsJson as string,
    issuesJson: run.issuesJson as string,
  };
}

export function assertKohoImportRunContract(
  value: unknown,
): asserts value is KohoImportRunContract {
  projectKohoImportRunContract(value);
}

function projectKohoImportPlan(value: unknown): KohoImportPlan {
  const plan = exactRecord(value, PLAN_KEYS, "invalid_plan_shape");
  const documents = exactArray(plan.documents, "invalid_plan_shape");
  const run = projectKohoImportRunContract({
    packageType: plan.packageType,
    sourceSha256: plan.sourceSha256,
    packageStatus: plan.packageStatus,
    documentCount: plan.documentCount,
    amendmentCount: plan.amendmentCount,
    nestedSt26Count: plan.nestedSt26Count,
    countsJson: plan.countsJson,
    issuesJson: plan.issuesJson,
  });
  if (run.documentCount !== documents.length) invalid("invalid_document_count");

  const paths = new Set<string>();
  const projectedDocuments: KohoImportDocumentPlan[] = [];
  for (const document of documents) {
    const projected = projectKohoImportDocumentPlan(document, run.packageType);
    if (paths.has(projected.normalizedEntryPath)) {
      invalid("duplicate_normalized_entry_path");
    }
    paths.add(projected.normalizedEntryPath);
    projectedDocuments.push(projected);
  }
  return { ...run, documents: projectedDocuments };
}

export function createKohoImportPlanSnapshot(value: unknown): KohoImportPlan {
  return projectKohoImportPlan(value);
}

export function assertKohoImportPlan(
  value: unknown,
): asserts value is KohoImportPlan {
  projectKohoImportPlan(value);
}
