import { createHash } from "node:crypto";
import type {
  KohoPackageCountSummary,
  KohoPackageParseResult,
  KohoPackageSection,
  KohoPackageXmlResult,
} from "../koho-package";
import type {
  KohoClassification,
  KohoDocumentKind,
  KohoFullPublicationResult,
  KohoIngestStatus,
} from "../koho-xml";
import { inspectKohoEntryPath } from "../koho-xml/path";
import {
  KohoImportPlanValidationError,
  type BuildKohoImportPlanInput,
  type KohoImportDocumentKind,
  type KohoImportDocumentPlan,
  type KohoImportPlan,
  type KohoImportPlanValidationErrorCode,
} from "./types";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_TYPES = new Set<string>(["JPA", "JPB"]);
const PACKAGE_STATUSES = new Set<string>([
  "success",
  "review_required",
  "failed",
]);
const XML_STATUSES = new Set<string>([
  "success",
  "review_required",
  "unsupported_type",
  "failed",
]);
const ISSUE_STATUSES = new Set<string>([
  "review_required",
  "unsupported_type",
  "failed",
]);
const ENTRY_TYPES = new Set<string>([
  "full_publication",
  "amendment",
  "nested_st26",
  "unknown",
]);
const DOCUMENT_KINDS = new Set<string>(["A1", "P1", "B1", "B2"]);
const ALL_KINDS = new Set<string>(["A1", "A5", "P1", "P5", "B1", "B2"]);
const SECTIONS = ["P_A1", "P_A5", "P_P1", "P_P5", "P_B1"] as const;
const SECTION_SET = new Set<string>(SECTIONS);
const ROLES = ["directory", "xml", "csv", "schema", "image", "other"] as const;

type ConfirmedFullPublicationResult = Extract<
  KohoFullPublicationResult,
  { identityConfirmed: true }
>;

interface SelectedDocument {
  entryId: number;
  normalizedEntryPath: string;
  result: ConfirmedFullPublicationResult;
}

interface KohoRunIssueAggregate {
  source: "package" | "xml";
  code: string;
  status: Exclude<KohoIngestStatus, "success">;
  kind: KohoDocumentKind | null;
  section: KohoPackageSection | null;
  count: number;
}

function invalid(code: KohoImportPlanValidationErrorCode): never {
  throw new KohoImportPlanValidationError(code);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function assertSafePrimaryPath(pathValue: unknown): asserts pathValue is string {
  if (typeof pathValue !== "string") {
    invalid("invalid_normalized_entry_path");
  }
  const inspected = inspectKohoEntryPath(pathValue);
  if (
    !inspected.ok ||
    inspected.normalizedPath !== pathValue ||
    !inspected.isPrimaryXml
  ) {
    invalid("invalid_normalized_entry_path");
  }
}

function assertKnownIssueStatus(
  status: unknown,
): asserts status is Exclude<KohoIngestStatus, "success"> {
  if (typeof status !== "string" || !ISSUE_STATUSES.has(status)) {
    invalid("invalid_issue_status");
  }
}

function assertCounts(
  counts: KohoPackageCountSummary | null | undefined,
): asserts counts is KohoPackageCountSummary {
  if (!counts || typeof counts !== "object") {
    invalid("invalid_counts");
  }
  const topLevel = [
    counts.primaryXmlCandidates,
    counts.finalXmlResults,
    counts.confirmedFullPublications,
    counts.confirmedAmendments,
    counts.nestedXmlCandidates,
    counts.documentFolders,
    counts.documentListRecords,
  ];
  if (topLevel.some((value) => !isNonNegativeInteger(value))) {
    invalid("invalid_counts");
  }

  for (const role of ROLES) {
    if (!isNonNegativeInteger(counts.roleCounts?.[role])) {
      invalid("invalid_counts");
    }
  }

  for (const section of SECTIONS) {
    const sectionCounts = counts.bySection?.[section];
    if (!sectionCounts) invalid("invalid_counts");
    const values = [
      sectionCounts.primaryXmlCandidates,
      sectionCounts.finalXmlResults,
      sectionCounts.confirmedFullPublications,
      sectionCounts.confirmedAmendments,
      sectionCounts.documentFolders,
      sectionCounts.contents1Records,
      sectionCounts.contents2Records,
      sectionCounts.attachmentCount,
    ];
    if (values.some((value) => !isNonNegativeInteger(value))) {
      invalid("invalid_counts");
    }
    for (const role of ROLES) {
      if (!isNonNegativeInteger(sectionCounts.roleCounts?.[role])) {
        invalid("invalid_counts");
      }
    }
  }
}

function projectRoleCounts(
  roleCounts: KohoPackageCountSummary["roleCounts"],
): KohoPackageCountSummary["roleCounts"] {
  return {
    directory: roleCounts.directory,
    xml: roleCounts.xml,
    csv: roleCounts.csv,
    schema: roleCounts.schema,
    image: roleCounts.image,
    other: roleCounts.other,
  };
}

function projectCountsJson(counts: KohoPackageCountSummary): string {
  const bySection = Object.fromEntries(
    SECTIONS.map((section) => {
      const source = counts.bySection[section];
      return [
        section,
        {
          primaryXmlCandidates: source.primaryXmlCandidates,
          finalXmlResults: source.finalXmlResults,
          confirmedFullPublications: source.confirmedFullPublications,
          confirmedAmendments: source.confirmedAmendments,
          documentFolders: source.documentFolders,
          contents1Records: source.contents1Records,
          contents2Records: source.contents2Records,
          attachmentCount: source.attachmentCount,
          roleCounts: projectRoleCounts(source.roleCounts),
        },
      ];
    }),
  );

  return JSON.stringify({
    primaryXmlCandidates: counts.primaryXmlCandidates,
    finalXmlResults: counts.finalXmlResults,
    confirmedFullPublications: counts.confirmedFullPublications,
    confirmedAmendments: counts.confirmedAmendments,
    nestedXmlCandidates: counts.nestedXmlCandidates,
    documentFolders: counts.documentFolders,
    documentListRecords: counts.documentListRecords,
    roleCounts: projectRoleCounts(counts.roleCounts),
    bySection,
  });
}

function assertPrimaryXmlResult(item: KohoPackageXmlResult): void {
  if (!item || typeof item !== "object") {
    invalid("invalid_primary_xml_result");
  }
  if (!isNonNegativeInteger(item.entryId)) invalid("invalid_entry_id");
  assertSafePrimaryPath(item.normalizedPath);

  const result = item.result;
  if (!result || typeof result !== "object") {
    invalid("invalid_primary_xml_result");
  }
  if (typeof result.status !== "string" || !XML_STATUSES.has(result.status)) {
    invalid("invalid_document_status");
  }
  if (typeof result.entryType !== "string" || !ENTRY_TYPES.has(result.entryType)) {
    invalid("invalid_entry_type");
  }
  if (
    result.kind !== null &&
    (typeof result.kind !== "string" || !ALL_KINDS.has(result.kind))
  ) {
    invalid("invalid_document_kind");
  }
  if (
    !result.source ||
    result.source.normalizedEntryPath !== item.normalizedPath
  ) {
    invalid("inconsistent_source_metadata");
  }
  for (const issue of result.issues) {
    assertKnownIssueStatus(issue.status);
  }
}

function isConfirmedFullPublication(
  result: KohoPackageXmlResult["result"],
): result is ConfirmedFullPublicationResult {
  return (
    result.entryType === "full_publication" &&
    "identityConfirmed" in result &&
    result.identityConfirmed === true &&
    "document" in result &&
    result.document !== null
  );
}

function assertDocumentPathContract(
  packageType: KohoPackageParseResult["packageType"],
  kind: KohoImportDocumentKind,
  normalizedEntryPath: string,
): void {
  const inspected = inspectKohoEntryPath(normalizedEntryPath);
  if (!inspected.ok || !inspected.isPrimaryXml) {
    invalid("invalid_normalized_entry_path");
  }
  const matches =
    packageType === "JPA"
      ? (kind === "A1" && inspected.section === "P_A1") ||
        (kind === "P1" && inspected.section === "P_P1")
      : (kind === "B1" || kind === "B2") && inspected.section === "P_B1";
  if (!matches) invalid("invalid_document_kind");
}

function selectDocuments(
  packageResult: KohoPackageParseResult,
): SelectedDocument[] {
  const selected: SelectedDocument[] = [];
  for (const item of packageResult.primaryXmlResults) {
    assertPrimaryXmlResult(item);
    if (!isConfirmedFullPublication(item.result)) continue;
    if (!DOCUMENT_KINDS.has(item.result.kind)) {
      invalid("invalid_document_kind");
    }

    const kind = item.result.kind as KohoImportDocumentKind;
    if (
      item.result.status !== "success" &&
      item.result.status !== "review_required"
    ) {
      invalid("invalid_document_status");
    }
    if (
      item.result.document.kind !== kind ||
      item.result.document.source.normalizedEntryPath !== item.normalizedPath
    ) {
      invalid("inconsistent_source_metadata");
    }
    assertDocumentPathContract(
      packageResult.packageType,
      kind,
      item.normalizedPath,
    );
    selected.push({
      entryId: item.entryId,
      normalizedEntryPath: item.normalizedPath,
      result: item.result,
    });
  }

  selected.sort((left, right) => {
    const byPath = compareText(
      left.normalizedEntryPath,
      right.normalizedEntryPath,
    );
    return byPath !== 0 ? byPath : left.entryId - right.entryId;
  });

  for (let index = 1; index < selected.length; index += 1) {
    if (
      selected[index - 1].normalizedEntryPath ===
      selected[index].normalizedEntryPath
    ) {
      invalid("duplicate_normalized_entry_path");
    }
  }
  return selected;
}

function projectClassification(
  classification: KohoClassification,
): {
  ordinal: number;
  role: KohoClassification["role"];
  value: string;
  sourceValue: string;
} {
  return {
    ordinal: classification.ordinal,
    role: classification.role,
    value: classification.value,
    sourceValue: classification.sourceValue,
  };
}

function sha256CanonicalJson(payload: object): string {
  return createHash("sha256")
    .update(Buffer.from(JSON.stringify(payload), "utf8"))
    .digest("hex");
}

function projectDocument(item: SelectedDocument): KohoImportDocumentPlan {
  const { result } = item;
  const { document } = result;
  const payload = {
    normalizedEntryPath: item.normalizedEntryPath,
    parseStatus: result.status,
    kind: document.kind,
    publicationNumber: document.publicationNumber.value,
    applicationNumber: document.applicationNumber.value,
    publicationDate: document.publicationDate.value,
    registrationNumber: document.registrationNumber?.value ?? null,
    registrationDate: document.registrationDate?.value ?? null,
    inventionTitle: document.inventionTitle.plainText,
    abstractText: document.abstract?.plainText ?? null,
    claimsText: document.claims.map((claim) => claim.plainText).join("\n\n"),
    applicantsJson: JSON.stringify(
      document.applicants.map((applicant) => ({
        ordinal: applicant.ordinal,
        sequenceNumber: applicant.sequenceNumber,
        names: applicant.names.map((name) => ({
          value: name.value,
          sourceValue: name.sourceValue,
          originalLanguageIndicator: name.originalLanguageIndicator,
        })),
      })),
    ),
    ipcJson: JSON.stringify(document.ipc.map(projectClassification)),
    fiJson: JSON.stringify(document.fi.map(projectClassification)),
    parseIssuesJson: JSON.stringify(
      result.issues.map((issue) => ({
        code: issue.code,
        status: issue.status,
        field: issue.field ?? null,
      })),
    ),
    sourceMetadataJson: JSON.stringify({
      normalizedEntryPath: document.source.normalizedEntryPath,
      rootLocalName: document.source.rootLocalName,
      rootNamespaceUri: document.source.rootNamespaceUri,
      schemaBasename: document.source.schemaBasename,
      st96Version: document.source.st96Version,
      ipoVersion: document.source.ipoVersion,
      languageCode: document.source.languageCode,
      xsdValidation: document.source.xsdValidation,
    }),
  } satisfies Omit<KohoImportDocumentPlan, "contentSha256">;

  return {
    ...payload,
    contentSha256: sha256CanonicalJson(payload),
  };
}

function issueAggregateKey(issue: Omit<KohoRunIssueAggregate, "count">): string {
  return JSON.stringify([
    issue.source,
    issue.code,
    issue.status,
    issue.kind,
    issue.section,
  ]);
}

function projectIssuesJson(packageResult: KohoPackageParseResult): string {
  const aggregates = new Map<string, KohoRunIssueAggregate>();
  const add = (issue: Omit<KohoRunIssueAggregate, "count">): void => {
    const key = issueAggregateKey(issue);
    const existing = aggregates.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      aggregates.set(key, { ...issue, count: 1 });
    }
  };

  for (const issue of packageResult.issues) {
    assertKnownIssueStatus(issue.status);
    const section = issue.section ?? null;
    if (section !== null && !SECTION_SET.has(section)) {
      invalid("invalid_issue_section");
    }
    add({
      source: "package",
      code: issue.code,
      status: issue.status,
      kind: null,
      section,
    });
  }

  for (const item of packageResult.primaryXmlResults) {
    for (const issue of item.result.issues) {
      assertKnownIssueStatus(issue.status);
      add({
        source: "xml",
        code: issue.code,
        status: issue.status,
        kind: item.result.kind,
        section: null,
      });
    }
  }

  const sorted = [...aggregates.values()].sort((left, right) => {
    return (
      compareText(left.source, right.source) ||
      compareText(left.code, right.code) ||
      compareText(left.status, right.status) ||
      compareNullableText(left.kind, right.kind) ||
      compareNullableText(left.section, right.section)
    );
  });
  return JSON.stringify(sorted);
}

export function buildKohoImportPlan(
  input: BuildKohoImportPlanInput,
): KohoImportPlan {
  const sourceSha256 = (input as BuildKohoImportPlanInput | null)?.sourceSha256;
  if (typeof sourceSha256 !== "string" || !SHA256_PATTERN.test(sourceSha256)) {
    invalid("invalid_source_sha256");
  }

  // Keep this access after hash validation so invalid hashes never touch source data.
  const packageResult = input.packageResult as
    | KohoPackageParseResult
    | null
    | undefined;
  if (!packageResult || typeof packageResult !== "object") {
    invalid("invalid_package_type");
  }
  if (!PACKAGE_TYPES.has(packageResult.packageType)) {
    invalid("invalid_package_type");
  }
  if (!PACKAGE_STATUSES.has(packageResult.status)) {
    invalid("invalid_package_status");
  }
  if (!Array.isArray(packageResult.primaryXmlResults)) {
    invalid("invalid_primary_xml_result");
  }
  if (!Array.isArray(packageResult.issues)) {
    invalid("invalid_issue_status");
  }
  assertCounts(packageResult.counts);

  const documents = selectDocuments(packageResult).map(projectDocument);
  return {
    packageType: packageResult.packageType,
    sourceSha256,
    packageStatus: packageResult.status,
    documentCount: documents.length,
    amendmentCount: packageResult.counts.confirmedAmendments,
    nestedSt26Count: packageResult.counts.nestedXmlCandidates,
    countsJson: projectCountsJson(packageResult.counts),
    issuesJson: projectIssuesJson(packageResult),
    documents,
  };
}
