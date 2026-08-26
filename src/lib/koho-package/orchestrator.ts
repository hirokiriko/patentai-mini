import {
  parseKohoCsv,
  type KohoCsvContractDocumentListRecord,
  type KohoCsvContractParseInput,
  type KohoCsvContractParseResult,
  type KohoCsvContractRecord,
} from "../koho-csv";
import {
  parseKohoXml,
  type KohoDocumentKind,
  type KohoXmlParseInput,
  type KohoXmlParseResult,
} from "../koho-xml";
import {
  KohoZipError,
  openKohoZip,
  type KohoZipEntry,
  type KohoZipEntryRole,
  type KohoZipReader,
} from "../koho-zip";
import type {
  KohoPackageCountSummary,
  KohoPackageCsvResult,
  KohoPackageEntryStatus,
  KohoPackageIssue,
  KohoPackageIssueCause,
  KohoPackageIssueCode,
  KohoPackageLimits,
  KohoPackageManifestEntry,
  KohoPackageParseInput,
  KohoPackageParseResult,
  KohoPackageSection,
  KohoPackageSectionCountSummary,
  KohoPackageStatus,
  KohoPackageType,
  KohoPackageXmlResult,
} from "./types";

const SECTIONS = ["P_A1", "P_A5", "P_P1", "P_P5", "P_B1"] as const;
const SECTION_SET = new Set<string>(SECTIONS);
const JPA_SECTIONS = new Set<KohoPackageSection>([
  "P_A1",
  "P_A5",
  "P_P1",
  "P_P5",
]);
const JPB_SECTIONS = new Set<KohoPackageSection>(["P_B1"]);
const KNOWN_CSV: ReadonlyMap<
  string,
  KohoCsvContractParseInput["logicalFile"]
> = new Map([
  ["ABSTRACT.csv", "abstract"],
  ["DOCUMENT_LIST.csv", "document_list"],
  ["CONTENTS1.csv", "contents1"],
  ["CONTENTS2.csv", "contents2"],
]);
const ROOT_CSV_PATHS = ["ABSTRACT.csv", "DOCUMENT_LIST.csv"] as const;
const ROLE_NAMES: readonly KohoZipEntryRole[] = [
  "directory",
  "xml",
  "csv",
  "schema",
  "image",
  "other",
];
const DASH_OR_SPACE = /[\s\-‐‑‒–—―]/gu;

const SAFE_MESSAGES: Record<KohoPackageIssueCode, string> = {
  invalid_limits: "Package parser limits or package type are invalid",
  zip_open_failed: "ZIP package could not be opened safely",
  zip_entry_read_failed: "A selected ZIP entry could not be read safely",
  reader_close_failed: "ZIP reader could not be closed safely",
  required_csv_missing: "A required root CSV entry is missing",
  required_csv_unreadable: "A required root CSV entry is not readable",
  csv_parse_failed: "A selected CSV entry could not be parsed under the public contract",
  unclassified_csv_entry: "An unclassified CSV entry was retained as metadata only",
  unclassified_xml_entry: "An unclassified XML entry was retained as metadata only",
  unreadable_attachment: "A non-required attachment is not readable",
  package_section_mismatch: "An entry section does not match the package type",
  document_list_match_missing: "A primary XML publication has no DOCUMENT_LIST match",
  document_list_match_ambiguous: "A publication match is ambiguous in DOCUMENT_LIST",
  document_list_orphan: "A DOCUMENT_LIST record has no primary XML match",
  document_list_count_mismatch: "DOCUMENT_LIST and primary XML counts do not match",
  abstract_summary_missing: "A required ABSTRACT section summary is missing",
  abstract_summary_ambiguous: "An ABSTRACT section summary is ambiguous",
  abstract_count_mismatch: "An ABSTRACT section count does not match primary XML candidates",
  contents_file_missing: "A canonical CONTENTS file is missing for a populated section",
  contents_record_missing: "A full publication has no matching CONTENTS record",
  contents_record_ambiguous: "A publication match is ambiguous in CONTENTS",
  contents_record_orphan: "A CONTENTS record has no matching full publication",
  primary_xml_parse_failed: "A primary XML entry failed the public XML parser contract",
  primary_xml_unconfirmed: "A primary XML entry could not be identity-confirmed",
};

interface QueuedIssue {
  issue: KohoPackageIssue;
  stage: number;
}

interface PackageDependencies {
  openZip: typeof openKohoZip;
  parseCsv: (input: KohoCsvContractParseInput) => KohoCsvContractParseResult;
  parseXml: (input: KohoXmlParseInput) => KohoXmlParseResult;
}

const DEFAULT_DEPENDENCIES: PackageDependencies = {
  openZip: openKohoZip,
  parseCsv: (input) => parseKohoCsv(input),
  parseXml: (input) => parseKohoXml(input),
};

interface XmlIdentity {
  publicationNumber: string;
  kind: KohoDocumentKind;
  entryType: "full_publication" | "amendment";
  identityConfirmed: boolean;
}

interface DocumentListView {
  record: KohoCsvContractDocumentListRecord;
  publicationNumber: string;
  kindCode: string;
  issuePublicationDate: string;
}

interface EntryParseOutcome<T> {
  attached: T | null;
  stopReader: boolean;
}

export async function parseKohoPackage(
  input: KohoPackageParseInput,
): Promise<KohoPackageParseResult> {
  return parseKohoPackageWithDependencies(input, {});
}

export async function parseKohoPackageWithDependencies(
  input: KohoPackageParseInput,
  overrides: Partial<PackageDependencies>,
): Promise<KohoPackageParseResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const queuedIssues: QueuedIssue[] = [];

  if (!isValidTopLevelInput(input)) {
    queueIssue(queuedIssues, 0, "invalid_limits", "failed");
    return finalizeResult({
      packageType: input.packageType,
      zipSummary: null,
      manifest: [],
      csvResults: [],
      primaryXmlResults: [],
      counts: emptyCounts(),
      queuedIssues,
    });
  }

  let reader: KohoZipReader | null = null;
  let readerReady = false;
  let entries: readonly KohoZipEntry[] = [];
  let zipSummary: KohoPackageParseResult["zipSummary"] = null;
  const manifestById = new Map<number, KohoPackageManifestEntry>();
  const csvResults: KohoPackageCsvResult[] = [];
  const primaryXmlResults: KohoPackageXmlResult[] = [];
  let counts = emptyCounts();

  try {
    try {
      reader = await dependencies.openZip({
        source: input.source,
        limits: input.limits.zip,
      });
      zipSummary = reader.summary;
      entries = reader.entries;
      readerReady = true;
    } catch (error) {
      queueIssue(
        queuedIssues,
        1,
        "zip_open_failed",
        "failed",
        undefined,
        undefined,
        undefined,
        undefined,
        zipCause(error),
      );
    }

    if (readerReady && reader) {
      initializeManifestAndMetadataIssues(
        entries,
        input.packageType,
        manifestById,
        queuedIssues,
      );

      let rootFatal = false;
      let readerStopped = false;
      const rootEntries = new Map<string, KohoZipEntry>();
      for (const path of ROOT_CSV_PATHS) {
        const entry = entries.find(
          (candidate) => candidate.normalizedPath === path,
        );
        if (!entry) {
          rootFatal = true;
          queueIssue(
            queuedIssues,
            2,
            "required_csv_missing",
            "failed",
            undefined,
            path,
          );
        } else {
          rootEntries.set(path, entry);
        }
      }

      if (!rootFatal) {
        for (const path of ROOT_CSV_PATHS) {
          const entry = rootEntries.get(path)!;
          const outcome = await parseCsvEntry(
            reader,
            entry,
            input,
            dependencies,
            manifestById,
            queuedIssues,
            true,
            true,
          );
          if (outcome.attached) csvResults.push(outcome.attached);
          if (
            !outcome.attached ||
            outcome.attached.result.status === "failed"
          ) {
            rootFatal = true;
            readerStopped = outcome.stopReader;
            break;
          }
        }
      }

      if (!rootFatal) {
        const remainingCsv = entries
          .filter(
            (entry) =>
              entry.role === "csv" &&
              knownCsvLogicalFile(entry.normalizedPath) !== null &&
              !ROOT_CSV_PATHS.includes(
                entry.normalizedPath as (typeof ROOT_CSV_PATHS)[number],
              ),
          )
          .sort(compareEntries);

        for (const entry of remainingCsv) {
          const canonical = isCanonicalCsvPath(
            input.packageType,
            entry.normalizedPath,
          );
          const outcome = await parseCsvEntry(
            reader,
            entry,
            input,
            dependencies,
            manifestById,
            queuedIssues,
            canonical,
            false,
          );
          if (outcome.attached) csvResults.push(outcome.attached);
          if (outcome.stopReader) {
            readerStopped = true;
            break;
          }
        }

        if (!readerStopped) {
          const documentList = getDocumentListViews(csvResults);
          const primaryEntries = entries
            .filter(
              (entry) =>
                entry.role === "xml" &&
                entry.pathCandidate === "primary_xml",
            )
            .sort(compareEntries);

          for (const entry of primaryEntries) {
            const outcome = await parsePrimaryXmlEntry(
              reader,
              entry,
              input,
              documentList,
              dependencies,
              manifestById,
              queuedIssues,
            );
            if (outcome.attached) {
              primaryXmlResults.push(outcome.attached);
            }
            if (outcome.stopReader) {
              readerStopped = true;
              break;
            }
          }
        }
      }

      counts = buildCounts(entries, csvResults, primaryXmlResults);
      if (!rootFatal && !readerStopped) {
        runCrossChecks(
          input.packageType,
          entries,
          csvResults,
          primaryXmlResults,
          counts,
          queuedIssues,
        );
      }
    }
  } finally {
    if (reader) {
      try {
        await reader.close();
      } catch (error) {
        queueIssue(
          queuedIssues,
          9,
          "reader_close_failed",
          "failed",
          undefined,
          undefined,
          undefined,
          undefined,
          zipCause(error),
        );
      }
    }
  }

  return finalizeResult({
    packageType: input.packageType,
    zipSummary,
    manifest: [...manifestById.values()].sort((a, b) => a.entryId - b.entryId),
    csvResults: csvResults.sort(compareAttachedResults),
    primaryXmlResults: primaryXmlResults.sort(compareAttachedResults),
    counts,
    queuedIssues,
  });
}

async function parseCsvEntry(
  reader: KohoZipReader,
  entry: KohoZipEntry,
  input: KohoPackageParseInput,
  dependencies: PackageDependencies,
  manifestById: Map<number, KohoPackageManifestEntry>,
  issues: QueuedIssue[],
  failureIsFatal: boolean,
  requiredRoot: boolean,
): Promise<EntryParseOutcome<KohoPackageCsvResult>> {
  const logicalFile = knownCsvLogicalFile(entry.normalizedPath);
  if (!logicalFile) return { attached: null, stopReader: false };

  if (!entry.canRead) {
    setManifest(manifestById, entry.id, "unreadable", failureIsFatal ? "failed" : "review_required");
    queueIssue(
      issues,
      3,
      requiredRoot ? "required_csv_unreadable" : "zip_entry_read_failed",
      failureIsFatal ? "failed" : "review_required",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      undefined,
      entryZipCause(entry),
    );
    return { attached: null, stopReader: false };
  }

  let bytes: Uint8Array;
  try {
    bytes = await reader.readEntryBytes(entry.id);
  } catch (error) {
    const stopReader = shouldStopReaderAfterError(error);
    const readFailureIsFatal = failureIsFatal || stopReader;
    setManifest(
      manifestById,
      entry.id,
      "unreadable",
      readFailureIsFatal ? "failed" : "review_required",
    );
    queueIssue(
      issues,
      3,
      requiredRoot ? "required_csv_unreadable" : "zip_entry_read_failed",
      readFailureIsFatal ? "failed" : "review_required",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      undefined,
      zipCause(error),
    );
    return {
      attached: null,
      stopReader,
    };
  }

  let result: KohoCsvContractParseResult;
  try {
    result = dependencies.parseCsv({
      packageType: input.packageType,
      logicalFile,
      entryPath: entry.normalizedPath,
      csv: bytes,
      limits: input.limits.csv,
    });
  } catch {
    setManifest(
      manifestById,
      entry.id,
      "parsed_csv",
      failureIsFatal ? "failed" : "review_required",
    );
    queueIssue(
      issues,
      4,
      "csv_parse_failed",
      failureIsFatal ? "failed" : "review_required",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
    );
    return { attached: null, stopReader: false };
  }
  const manifestStatus = childStatus(result.status);
  setManifest(manifestById, entry.id, "parsed_csv", manifestStatus);

  if (result.status === "failed") {
    const failure = csvFailureMetadata(result);
    queueIssue(
      issues,
      4,
      "csv_parse_failed",
      failureIsFatal ? "failed" : "review_required",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      failure?.recordNumber,
      failure?.cause,
    );
  }

  return {
    attached: {
      entryId: entry.id,
      normalizedPath: entry.normalizedPath,
      result,
    },
    stopReader: false,
  };
}

async function parsePrimaryXmlEntry(
  reader: KohoZipReader,
  entry: KohoZipEntry,
  input: KohoPackageParseInput,
  documentList: readonly DocumentListView[],
  dependencies: PackageDependencies,
  manifestById: Map<number, KohoPackageManifestEntry>,
  issues: QueuedIssue[],
): Promise<EntryParseOutcome<KohoPackageXmlResult>> {
  if (!entry.canRead) {
    setManifest(manifestById, entry.id, "unreadable", "failed");
    queueIssue(
      issues,
      5,
      "zip_entry_read_failed",
      "failed",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      undefined,
      entryZipCause(entry),
    );
    return { attached: null, stopReader: false };
  }

  let bytes: Uint8Array;
  try {
    bytes = await reader.readEntryBytes(entry.id);
  } catch (error) {
    setManifest(manifestById, entry.id, "unreadable", "failed");
    queueIssue(
      issues,
      5,
      "zip_entry_read_failed",
      "failed",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      undefined,
      zipCause(error),
    );
    return {
      attached: null,
      stopReader: shouldStopReaderAfterError(error),
    };
  }

  const baseInput: KohoXmlParseInput = {
    packageType: input.packageType,
    entryPath: entry.normalizedPath,
    xml: bytes,
    limits: input.limits.xml,
  };
  let bootstrap: KohoXmlParseResult;
  try {
    bootstrap = dependencies.parseXml(baseInput);
  } catch {
    setManifest(manifestById, entry.id, "parsed_primary_xml", "failed");
    queueIssue(
      issues,
      6,
      "primary_xml_parse_failed",
      "failed",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
    );
    return { attached: null, stopReader: false };
  }
  let finalResult = bootstrap;
  const identity = xmlIdentity(bootstrap);

  if (bootstrap.status !== "failed" && identity) {
    const matches = documentList.filter((record) =>
      publicationMatches(
        identity.publicationNumber,
        record.publicationNumber,
        identity.kind,
      ),
    );
    if (matches.length === 0) {
      queueIssue(
        issues,
        5,
        "document_list_match_missing",
        "review_required",
        entry.id,
        entry.normalizedPath,
        sectionFromPath(entry.normalizedPath),
      );
    } else if (!hasConsensus(matches)) {
      queueIssue(
        issues,
        5,
        "document_list_match_ambiguous",
        "review_required",
        entry.id,
        entry.normalizedPath,
        sectionFromPath(entry.normalizedPath),
      );
    } else {
      const consensus = matches[0];
      try {
        finalResult = dependencies.parseXml({
          ...baseInput,
          indexHint: {
            kindCode: consensus.kindCode,
            publicationNumber: consensus.publicationNumber,
            publicationDate: consensus.issuePublicationDate,
          },
        });
      } catch {
        setManifest(manifestById, entry.id, "parsed_primary_xml", "failed");
        queueIssue(
          issues,
          6,
          "primary_xml_parse_failed",
          "failed",
          entry.id,
          entry.normalizedPath,
          sectionFromPath(entry.normalizedPath),
        );
        return { attached: null, stopReader: false };
      }
    }
  }

  if (finalResult.status === "failed") {
    queueIssue(
      issues,
      6,
      "primary_xml_parse_failed",
      "failed",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      undefined,
      xmlCause(finalResult),
    );
  } else if (!isIdentityConfirmed(finalResult)) {
    queueIssue(
      issues,
      6,
      "primary_xml_unconfirmed",
      "review_required",
      entry.id,
      entry.normalizedPath,
      sectionFromPath(entry.normalizedPath),
      undefined,
      xmlCause(finalResult),
    );
  }

  setManifest(
    manifestById,
    entry.id,
    "parsed_primary_xml",
    childStatus(finalResult.status),
  );
  return {
    attached: {
      entryId: entry.id,
      normalizedPath: entry.normalizedPath,
      result: finalResult,
    },
    stopReader: false,
  };
}

function initializeManifestAndMetadataIssues(
  entries: readonly KohoZipEntry[],
  packageType: KohoPackageType,
  manifestById: Map<number, KohoPackageManifestEntry>,
  issues: QueuedIssue[],
): void {
  for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
    let processing: KohoPackageManifestEntry["processing"] = "unclassified";
    let status: KohoPackageEntryStatus = "not_processed";
    const selectedCsv =
      entry.role === "csv" &&
      knownCsvLogicalFile(entry.normalizedPath) !== null;
    const selectedPrimaryXml =
      entry.role === "xml" && entry.pathCandidate === "primary_xml";

    if (entry.role === "xml" && entry.pathCandidate === "nested_xml") {
      processing = "counted_nested_xml";
    } else if (entry.role === "xml" && entry.pathCandidate === "none") {
      processing = "unclassified";
      status = "review_required";
      queueIssue(
        issues,
        2,
        "unclassified_xml_entry",
        "review_required",
        entry.id,
        entry.normalizedPath,
        sectionFromPath(entry.normalizedPath),
      );
    } else if (entry.role === "csv" && !knownCsvLogicalFile(entry.normalizedPath)) {
      processing = "unclassified";
      status = "review_required";
      queueIssue(
        issues,
        2,
        "unclassified_csv_entry",
        "review_required",
        entry.id,
        entry.normalizedPath,
        sectionFromPath(entry.normalizedPath),
      );
    } else if (
      entry.role !== "csv" &&
      !selectedPrimaryXml
    ) {
      processing =
        entry.canRead || entry.isDirectory
          ? "ignored_attachment"
          : "unreadable";
    }

    if (
      !selectedCsv &&
      !selectedPrimaryXml &&
      !entry.canRead &&
      !entry.isDirectory
    ) {
      status = "review_required";
      queueIssue(
        issues,
        2,
        "unreadable_attachment",
        "review_required",
        entry.id,
        entry.normalizedPath,
        sectionFromPath(entry.normalizedPath),
        undefined,
        entryZipCause(entry),
      );
    }

    const section = sectionFromPath(entry.normalizedPath);
    if (section && !sectionAllowed(packageType, section)) {
      queueIssue(
        issues,
        2,
        "package_section_mismatch",
        "review_required",
        entry.id,
        entry.normalizedPath,
        section,
      );
    }

    manifestById.set(entry.id, {
      entryId: entry.id,
      normalizedPath: entry.normalizedPath,
      role: entry.role,
      pathCandidate: entry.pathCandidate,
      canRead: entry.canRead,
      processing,
      status,
    });
  }
}

function runCrossChecks(
  packageType: KohoPackageType,
  entries: readonly KohoZipEntry[],
  csvResults: readonly KohoPackageCsvResult[],
  xmlResults: readonly KohoPackageXmlResult[],
  counts: KohoPackageCountSummary,
  issues: QueuedIssue[],
): void {
  checkAbstract(csvResults, counts, issues);
  checkDocumentList(csvResults, xmlResults, counts, issues);
  checkContents(packageType, entries, csvResults, xmlResults, counts, issues);
}

function checkAbstract(
  csvResults: readonly KohoPackageCsvResult[],
  counts: KohoPackageCountSummary,
  issues: QueuedIssue[],
): void {
  const abstractResult = csvResults.find(
    (item) => item.normalizedPath === "ABSTRACT.csv" && item.result.logicalFile === "abstract",
  );
  if (!abstractResult || abstractResult.result.logicalFile !== "abstract") return;

  const summaries = abstractResult.result.records
    .map((record) => ({ record, semantic: record.semantic }))
    .filter(
      (item): item is typeof item & {
        semantic: NonNullable<typeof item.semantic> & { recordType: "summary" };
      } => item.semantic?.recordType === "summary",
    );

  for (const item of summaries) {
    if (item.semantic.section === null) {
      queueIssue(
        issues,
        7,
        "abstract_summary_ambiguous",
        "review_required",
        abstractResult.entryId,
        abstractResult.normalizedPath,
        undefined,
        item.record.recordNumber,
      );
    }
  }

  for (const section of SECTIONS) {
    const candidateCount = counts.bySection[section].primaryXmlCandidates;
    const matches = summaries.filter((item) => item.semantic.section === section);
    if (matches.length === 0) {
      if (candidateCount > 0) {
        queueIssue(
          issues,
          7,
          "abstract_summary_missing",
          "review_required",
          undefined,
          undefined,
          section,
        );
      }
      continue;
    }
    if (matches.length > 1) {
      queueIssue(issues, 7, "abstract_summary_ambiguous", "review_required", undefined, undefined, section);
      continue;
    }
    if (matches[0].semantic.documentCount.value !== candidateCount) {
      queueIssue(issues, 7, "abstract_count_mismatch", "review_required", undefined, undefined, section);
    }
  }
}

function checkDocumentList(
  csvResults: readonly KohoPackageCsvResult[],
  xmlResults: readonly KohoPackageXmlResult[],
  counts: KohoPackageCountSummary,
  issues: QueuedIssue[],
): void {
  const records = getDocumentListViews(csvResults);
  if (records.length !== counts.primaryXmlCandidates) {
    queueIssue(issues, 7, "document_list_count_mismatch", "review_required");
  }

  const identities = xmlResults
    .map((item) => ({ item, identity: xmlIdentity(item.result) }))
    .filter((item): item is typeof item & { identity: XmlIdentity } => item.identity !== null);

  for (const { item, identity } of identities) {
    const matches = records.filter((record) =>
      publicationMatches(
        identity.publicationNumber,
        record.publicationNumber,
        identity.kind,
      ),
    );
    if (matches.length === 0 && !hasIssue(issues, "document_list_match_missing", item.entryId)) {
      queueIssue(
        issues,
        7,
        "document_list_match_missing",
        "review_required",
        item.entryId,
        item.normalizedPath,
        sectionFromPath(item.normalizedPath),
      );
    } else if (
      matches.length > 1 &&
      !hasConsensus(matches) &&
      !hasIssue(issues, "document_list_match_ambiguous", item.entryId)
    ) {
      queueIssue(
        issues,
        7,
        "document_list_match_ambiguous",
        "review_required",
        item.entryId,
        item.normalizedPath,
        sectionFromPath(item.normalizedPath),
      );
    }
  }

  for (const record of records) {
    const matches = identities.filter(({ identity }) =>
      publicationMatches(
        identity.publicationNumber,
        record.publicationNumber,
        identity.kind,
      ),
    );
    if (matches.length === 0) {
      queueIssue(
        issues,
        7,
        "document_list_orphan",
        "review_required",
        undefined,
        "DOCUMENT_LIST.csv",
        undefined,
        record.record.recordNumber,
      );
    } else if (matches.length > 1) {
      queueIssue(
        issues,
        7,
        "document_list_match_ambiguous",
        "review_required",
        undefined,
        "DOCUMENT_LIST.csv",
        undefined,
        record.record.recordNumber,
      );
    }
  }
}

function checkContents(
  packageType: KohoPackageType,
  entries: readonly KohoZipEntry[],
  csvResults: readonly KohoPackageCsvResult[],
  xmlResults: readonly KohoPackageXmlResult[],
  counts: KohoPackageCountSummary,
  issues: QueuedIssue[],
): void {
  const fullSections: readonly KohoPackageSection[] =
    packageType === "JPA" ? ["P_A1", "P_P1"] : ["P_B1"];
  const identities = xmlResults
    .map((item) => ({ item, identity: xmlIdentity(item.result) }))
    .filter(
      (item): item is typeof item & { identity: XmlIdentity } =>
        item.identity !== null && item.identity.entryType === "full_publication",
    );

  for (const section of fullSections) {
    const candidateCount = counts.bySection[section].primaryXmlCandidates;
    for (const logicalFile of ["contents1", "contents2"] as const) {
      const expectedPath = `DOCUMENT/${section}/${logicalFile === "contents1" ? "CONTENTS1.csv" : "CONTENTS2.csv"}`;
      const entry = entries.find((candidate) => candidate.normalizedPath === expectedPath);
      const attached = csvResults.find(
        (candidate) =>
          candidate.normalizedPath === expectedPath && candidate.result.logicalFile === logicalFile,
      );
      if (!entry) {
        if (candidateCount > 0) {
          queueIssue(
            issues,
            8,
            "contents_file_missing",
            "review_required",
            undefined,
            expectedPath,
            section,
          );
        }
        continue;
      }
      if (!attached) {
        continue;
      }
      if (attached.result.logicalFile !== logicalFile) continue;
      const records = attached.result.records.filter((record) => record.semantic !== null);
      const sectionXml = identities.filter(
        ({ item }) => sectionFromPath(item.normalizedPath) === section,
      );

      for (const { item, identity } of sectionXml) {
        const matches = records.filter((record) => {
          const publicationNumber = contentsPublicationNumber(logicalFile, record);
          return (
            publicationNumber !== null &&
            publicationMatches(
              identity.publicationNumber,
              publicationNumber,
              identity.kind,
            )
          );
        });
        if (matches.length === 0) {
          queueIssue(
            issues,
            8,
            "contents_record_missing",
            "review_required",
            item.entryId,
            attached.normalizedPath,
            section,
          );
        } else if (matches.length > 1) {
          queueIssue(
            issues,
            8,
            "contents_record_ambiguous",
            "review_required",
            item.entryId,
            attached.normalizedPath,
            section,
          );
        }
      }

      for (const record of records) {
        const publicationNumber = contentsPublicationNumber(logicalFile, record);
        if (publicationNumber === null) continue;
        const matches = sectionXml.filter(({ identity }) =>
          publicationMatches(
            identity.publicationNumber,
            publicationNumber,
            identity.kind,
          ),
        );
        if (matches.length === 0) {
          queueIssue(
            issues,
            8,
            "contents_record_orphan",
            "review_required",
            attached.entryId,
            attached.normalizedPath,
            section,
            record.recordNumber,
          );
        } else if (matches.length > 1) {
          queueIssue(
            issues,
            8,
            "contents_record_ambiguous",
            "review_required",
            attached.entryId,
            attached.normalizedPath,
            section,
            record.recordNumber,
          );
        }
      }
    }
  }
}

function buildCounts(
  entries: readonly KohoZipEntry[],
  csvResults: readonly KohoPackageCsvResult[],
  xmlResults: readonly KohoPackageXmlResult[],
): KohoPackageCountSummary {
  const counts = emptyCounts();
  const documentFolders = new Set<string>();

  for (const entry of entries) {
    counts.roleCounts[entry.role] += 1;
    const section = sectionFromPath(entry.normalizedPath);
    if (section) {
      counts.bySection[section].roleCounts[entry.role] += 1;
      if (
        entry.role === "schema" ||
        entry.role === "image" ||
        entry.role === "other" ||
        (entry.role === "xml" && entry.pathCandidate !== "primary_xml")
      ) {
        counts.bySection[section].attachmentCount += 1;
      }
      if (entry.role === "xml" && entry.pathCandidate === "primary_xml") {
        counts.bySection[section].primaryXmlCandidates += 1;
      }
    }
    if (entry.role === "xml" && entry.pathCandidate === "primary_xml") {
      counts.primaryXmlCandidates += 1;
    }
    if (entry.role === "xml" && entry.pathCandidate === "nested_xml") {
      counts.nestedXmlCandidates += 1;
    }
    const folder = documentFolderFromPath(entry.normalizedPath);
    if (folder) documentFolders.add(folder);
  }

  counts.documentFolders = documentFolders.size;
  for (const section of SECTIONS) {
    counts.bySection[section].documentFolders = [...documentFolders].filter((folder) =>
      folder.startsWith(`DOCUMENT/${section}/`),
    ).length;
  }

  const documentList = getDocumentListViews(csvResults);
  counts.documentListRecords = documentList.length;

  for (const attached of csvResults) {
    const section = sectionFromPath(attached.normalizedPath);
    if (!section) continue;
    const semanticCount = attached.result.records.filter((record) => record.semantic !== null).length;
    if (attached.result.logicalFile === "contents1") {
      counts.bySection[section].contents1Records += semanticCount;
    } else if (attached.result.logicalFile === "contents2") {
      counts.bySection[section].contents2Records += semanticCount;
    }
  }

  counts.finalXmlResults = xmlResults.length;
  for (const attached of xmlResults) {
    const section = sectionFromPath(attached.normalizedPath);
    if (section) counts.bySection[section].finalXmlResults += 1;
    const identity = xmlIdentity(attached.result);
    if (!identity?.identityConfirmed) continue;
    if (identity.entryType === "full_publication") {
      counts.confirmedFullPublications += 1;
      if (section) counts.bySection[section].confirmedFullPublications += 1;
    } else {
      counts.confirmedAmendments += 1;
      if (section) counts.bySection[section].confirmedAmendments += 1;
    }
  }

  return counts;
}

function emptyCounts(): KohoPackageCountSummary {
  const roleCounts = emptyRoleCounts();
  const bySection = Object.fromEntries(
    SECTIONS.map((section) => [section, emptySectionCounts()]),
  ) as Record<KohoPackageSection, KohoPackageSectionCountSummary>;
  return {
    primaryXmlCandidates: 0,
    finalXmlResults: 0,
    confirmedFullPublications: 0,
    confirmedAmendments: 0,
    nestedXmlCandidates: 0,
    documentFolders: 0,
    documentListRecords: 0,
    roleCounts,
    bySection,
  };
}

function emptySectionCounts(): KohoPackageSectionCountSummary {
  return {
    primaryXmlCandidates: 0,
    finalXmlResults: 0,
    confirmedFullPublications: 0,
    confirmedAmendments: 0,
    documentFolders: 0,
    contents1Records: 0,
    contents2Records: 0,
    attachmentCount: 0,
    roleCounts: emptyRoleCounts(),
  };
}

function emptyRoleCounts(): Record<KohoZipEntryRole, number> {
  return Object.fromEntries(ROLE_NAMES.map((role) => [role, 0])) as Record<
    KohoZipEntryRole,
    number
  >;
}

function getDocumentListViews(
  csvResults: readonly KohoPackageCsvResult[],
): DocumentListView[] {
  const result = csvResults.find(
    (item) =>
      item.normalizedPath === "DOCUMENT_LIST.csv" &&
      item.result.logicalFile === "document_list",
  );
  if (!result || result.result.logicalFile !== "document_list") return [];
  return result.result.records.flatMap((record) => {
    const semantic = record.semantic;
    if (!semantic) return [];
    return [
      {
        record,
        publicationNumber: semantic.publicationNumber,
        kindCode: semantic.kindCode.sourceValue,
        issuePublicationDate: semantic.issuePublicationDate,
      },
    ];
  });
}

function contentsPublicationNumber(
  logicalFile: "contents1" | "contents2",
  record: KohoCsvContractRecord<unknown>,
): string | null {
  const semantic = record.semantic as
    | { formattedPublicationNumber?: unknown; publicationNumber?: unknown }
    | null;
  if (!semantic) return null;
  const value =
    logicalFile === "contents1"
      ? semantic.formattedPublicationNumber
      : semantic.publicationNumber;
  return typeof value === "string" ? value : null;
}

function xmlIdentity(result: KohoXmlParseResult): XmlIdentity | null {
  if ("document" in result) {
    const document = result.document ?? result.candidate;
    if (!document || !result.kind) return null;
    return {
      publicationNumber: document.publicationNumber.value,
      kind: result.kind,
      entryType: "full_publication",
      identityConfirmed: result.identityConfirmed,
    };
  }
  if ("amendment" in result) {
    const amendment = result.amendment ?? result.candidate;
    if (!amendment || !result.kind) return null;
    return {
      publicationNumber: amendment.publicationNumber.value,
      kind: result.kind,
      entryType: "amendment",
      identityConfirmed: result.identityConfirmed,
    };
  }
  return null;
}

function isIdentityConfirmed(result: KohoXmlParseResult): boolean {
  return "identityConfirmed" in result && result.identityConfirmed === true;
}

function hasConsensus(matches: readonly DocumentListView[]): boolean {
  if (matches.length <= 1) return matches.length === 1;
  const first = matches[0];
  return matches.every(
    (item) =>
      item.kindCode === first.kindCode &&
      item.issuePublicationDate === first.issuePublicationDate,
  );
}

function publicationMatches(
  left: string,
  right: string,
  kind: string | null,
): boolean {
  return (
    normalizePublicationNumber(left, kind) ===
    normalizePublicationNumber(right, kind)
  );
}

function normalizePublicationNumber(value: string, kind: string | null): string {
  let normalized = value.normalize("NFC").toUpperCase().replace(DASH_OR_SPACE, "");
  if ((kind === "B1" || kind === "B2") && /^[0-9]+$/.test(normalized)) {
    normalized = normalized.replace(/^0+(?=\d)/, "");
  }
  return normalized;
}

function knownCsvLogicalFile(
  normalizedPath: string,
): KohoCsvContractParseInput["logicalFile"] | null {
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  return KNOWN_CSV.get(basename) ?? null;
}

function isCanonicalCsvPath(packageType: KohoPackageType, path: string): boolean {
  const canonical =
    packageType === "JPA"
      ? new Set([
          "DOCUMENT/P_A1/CONTENTS1.csv",
          "DOCUMENT/P_A1/CONTENTS2.csv",
          "DOCUMENT/P_P1/CONTENTS1.csv",
          "DOCUMENT/P_P1/CONTENTS2.csv",
        ])
      : new Set([
          "DOCUMENT/P_B1/CONTENTS1.csv",
          "DOCUMENT/P_B1/CONTENTS2.csv",
        ]);
  return canonical.has(path);
}

function sectionFromPath(path: string): KohoPackageSection | undefined {
  const segments = path.split("/");
  if (segments[0] !== "DOCUMENT") return undefined;
  const candidate = segments[1];
  return SECTION_SET.has(candidate) ? (candidate as KohoPackageSection) : undefined;
}

function documentFolderFromPath(path: string): string | null {
  const segments = path.split("/");
  if (
    segments[0] !== "DOCUMENT" ||
    !SECTION_SET.has(segments[1] ?? "") ||
    segments.length < 5
  ) {
    return null;
  }
  return segments.slice(0, 5).join("/");
}

function sectionAllowed(packageType: KohoPackageType, section: KohoPackageSection): boolean {
  return packageType === "JPA" ? JPA_SECTIONS.has(section) : JPB_SECTIONS.has(section);
}

function compareEntries(a: KohoZipEntry, b: KohoZipEntry): number {
  return compareText(a.normalizedPath, b.normalizedPath) || a.id - b.id;
}

function compareAttachedResults(
  a: { normalizedPath: string; entryId: number },
  b: { normalizedPath: string; entryId: number },
): number {
  return compareText(a.normalizedPath, b.normalizedPath) || a.entryId - b.entryId;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function childStatus(status: string): KohoPackageEntryStatus {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "review_required";
}

function setManifest(
  manifestById: Map<number, KohoPackageManifestEntry>,
  entryId: number,
  processing: KohoPackageManifestEntry["processing"],
  status: KohoPackageEntryStatus,
): void {
  const current = manifestById.get(entryId);
  if (!current) return;
  manifestById.set(entryId, { ...current, processing, status });
}

function isValidTopLevelInput(input: KohoPackageParseInput): boolean {
  if (input.packageType !== "JPA" && input.packageType !== "JPB") return false;
  const limits: KohoPackageLimits | null = input.limits ?? null;
  if (!limits || !limits.zip || !limits.csv || !limits.xml) return false;
  return [
    limits.zip.maxSourceBytes,
    limits.zip.maxCentralDirectoryBytes,
    limits.zip.maxEntries,
    limits.zip.maxTotalCompressedBytes,
    limits.zip.maxTotalUncompressedBytes,
    limits.zip.maxEntryCompressedBytes,
    limits.zip.maxEntryUncompressedBytes,
    limits.zip.maxTotalReadUncompressedBytes,
    limits.csv.maxInputBytes,
    limits.csv.maxRecords,
    limits.csv.maxColumnsPerRecord,
    limits.csv.maxCellCharacters,
    limits.csv.maxTotalCharacters,
    limits.xml.maxXmlBytes,
    limits.xml.maxDepth,
    limits.xml.maxElements,
    limits.xml.maxTextBytes,
  ].every(isPositiveSafeInteger);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(value) && value > 0;
}

function entryZipCause(entry: KohoZipEntry): KohoPackageIssueCause | undefined {
  const code = entry.issues[0]?.code;
  return code ? { source: "zip", code } : undefined;
}

function zipCause(error: unknown): KohoPackageIssueCause | undefined {
  if (error instanceof KohoZipError) return { source: "zip", code: error.code };
  return undefined;
}

function shouldStopReaderAfterError(error: unknown): boolean {
  return !(
    error instanceof KohoZipError &&
    (error.code === "encrypted_entry" ||
      error.code === "unsupported_compression")
  );
}

function csvFailureMetadata(
  result: KohoCsvContractParseResult,
):
  | {
      recordNumber?: number;
      cause: KohoPackageIssueCause;
    }
  | undefined {
  const candidates = [
    ...result.issues.map((issue) => ({
      issue,
      recordNumber: undefined as number | undefined,
    })),
    ...result.records.flatMap((record) =>
      record.issues.map((issue) => ({
        issue,
        recordNumber: record.recordNumber,
      })),
    ),
  ];
  const selected =
    candidates.find(({ issue }) => issue.status === "failed") ??
    candidates[0];
  return selected
    ? {
        ...(selected.recordNumber === undefined
          ? {}
          : { recordNumber: selected.recordNumber }),
        cause: { source: "csv", code: selected.issue.code },
      }
    : undefined;
}

function xmlCause(result: KohoXmlParseResult): KohoPackageIssueCause | undefined {
  const issue = result.issues.find((candidate) => candidate.status === "failed") ?? result.issues[0];
  return issue ? { source: "xml", code: issue.code } : undefined;
}

function queueIssue(
  target: QueuedIssue[],
  stage: number,
  code: KohoPackageIssueCode,
  status: Exclude<KohoPackageStatus, "success">,
  entryId?: number,
  normalizedPath?: string,
  section?: KohoPackageSection,
  recordNumber?: number,
  cause?: KohoPackageIssueCause,
): void {
  target.push({
    stage,
    issue: {
      code,
      status,
      message: SAFE_MESSAGES[code],
      ...(entryId === undefined ? {} : { entryId }),
      ...(normalizedPath === undefined ? {} : { normalizedPath }),
      ...(section === undefined ? {} : { section }),
      ...(recordNumber === undefined ? {} : { recordNumber }),
      ...(cause === undefined ? {} : { cause }),
    },
  });
}

function hasIssue(
  target: readonly QueuedIssue[],
  code: KohoPackageIssueCode,
  entryId: number,
): boolean {
  return target.some((item) => item.issue.code === code && item.issue.entryId === entryId);
}

function sortIssues(items: readonly QueuedIssue[]): KohoPackageIssue[] {
  return [...items]
    .sort(
      (a, b) =>
        a.stage - b.stage ||
        compareText(
          a.issue.normalizedPath ?? "",
          b.issue.normalizedPath ?? "",
        ) ||
        (a.issue.entryId ?? Number.MAX_SAFE_INTEGER) -
          (b.issue.entryId ?? Number.MAX_SAFE_INTEGER) ||
        (a.issue.recordNumber ?? Number.MAX_SAFE_INTEGER) -
          (b.issue.recordNumber ?? Number.MAX_SAFE_INTEGER) ||
        compareText(a.issue.code, b.issue.code),
    )
    .map((item) => item.issue);
}

function finalizeResult(input: {
  packageType: KohoPackageType;
  zipSummary: KohoPackageParseResult["zipSummary"];
  manifest: KohoPackageManifestEntry[];
  csvResults: KohoPackageCsvResult[];
  primaryXmlResults: KohoPackageXmlResult[];
  counts: KohoPackageCountSummary;
  queuedIssues: QueuedIssue[];
}): KohoPackageParseResult {
  const issues = sortIssues(input.queuedIssues);
  const status = rollUpStatus(issues, input.csvResults, input.primaryXmlResults);
  return {
    status,
    packageType: input.packageType,
    zipSummary: input.zipSummary,
    manifest: input.manifest,
    csvResults: input.csvResults,
    primaryXmlResults: input.primaryXmlResults,
    counts: input.counts,
    issues,
  };
}

function rollUpStatus(
  issues: readonly KohoPackageIssue[],
  csvResults: readonly KohoPackageCsvResult[],
  xmlResults: readonly KohoPackageXmlResult[],
): KohoPackageStatus {
  if (issues.some((issue) => issue.status === "failed")) return "failed";
  if (issues.length > 0) return "review_required";
  if (csvResults.some((item) => item.result.status !== "success")) {
    return "review_required";
  }
  if (xmlResults.some((item) => item.result.status !== "success" || !isIdentityConfirmed(item.result))) {
    return "review_required";
  }
  return "success";
}
