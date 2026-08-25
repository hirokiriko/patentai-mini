import { ALL_KNOWN_KINDS, KNOWN_KINDS } from "./constants";
import {
  addIssueOnce,
  createIssue,
  finalizeRecord,
  rollupFileStatus,
} from "./issues";
import type {
  KohoCsvDocumentListProjection,
  KohoCsvDocumentListRecord,
  KohoCsvIssue,
  KohoCsvKnownKind,
  KohoCsvPackageType,
  ParsedCsvRecord,
} from "./types";

export interface ParseDocumentListInput {
  packageType: KohoCsvPackageType;
  records: ParsedCsvRecord[];
}

export interface ParseDocumentListOutput {
  status: "success" | "review_required" | "failed";
  issues: KohoCsvIssue[];
  records: KohoCsvDocumentListRecord[];
}

function isGregorianDate(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function parseRecord(
  parsed: ParsedCsvRecord,
  packageType: KohoCsvPackageType,
): KohoCsvDocumentListRecord {
  const [countryCode = "", publicationNumber = "", kindCode = "", issuePublicationDate = ""] =
    parsed.sourceCells;
  const record: KohoCsvDocumentListRecord = {
    ordinal: parsed.ordinal,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    rawRecord: parsed.rawRecord,
    sourceCells: parsed.sourceCells,
    projection: null,
    status: "success",
    issues: [],
  };

  if (parsed.rawRecord === "") {
    record.issues.push(createIssue("empty_record", { recordOrdinal: parsed.ordinal }));
  }
  if (parsed.sourceCells.length !== 4) {
    record.issues.push(
      createIssue("column_count_mismatch", {
        recordOrdinal: parsed.ordinal,
        field: "documentList",
      }),
    );
  }
  if (countryCode === "") {
    record.issues.push(
      createIssue("required_field_empty", {
        recordOrdinal: parsed.ordinal,
        field: "countryCode",
      }),
    );
  } else if (countryCode !== "JP") {
    record.issues.push(
      createIssue("unknown_country_code", {
        recordOrdinal: parsed.ordinal,
        field: "countryCode",
      }),
    );
  }
  if (publicationNumber === "") {
    record.issues.push(
      createIssue("required_field_empty", {
        recordOrdinal: parsed.ordinal,
        field: "publicationNumber",
      }),
    );
  }
  if (kindCode === "") {
    record.issues.push(
      createIssue("required_field_empty", {
        recordOrdinal: parsed.ordinal,
        field: "kindCode",
      }),
    );
  } else if (KNOWN_KINDS[packageType].has(kindCode)) {
    // Known and compatible.
  } else if (ALL_KNOWN_KINDS.has(kindCode)) {
    record.issues.push(
      createIssue("package_kind_mismatch", {
        recordOrdinal: parsed.ordinal,
        field: "kindCode",
      }),
    );
  } else {
    record.issues.push(
      createIssue("unknown_kind", {
        recordOrdinal: parsed.ordinal,
        field: "kindCode",
      }),
    );
  }
  if (!isGregorianDate(issuePublicationDate)) {
    record.issues.push(
      createIssue("invalid_date", {
        recordOrdinal: parsed.ordinal,
        field: "issuePublicationDate",
      }),
    );
  }

  record.projection = {
    countryCode: {
      sourceValue: countryCode,
      knownValue: countryCode === "JP" ? "JP" : null,
    },
    publicationNumber,
    kindCode: {
      sourceValue: kindCode,
      knownValue: ALL_KNOWN_KINDS.has(kindCode)
        ? (kindCode as KohoCsvKnownKind)
        : null,
    },
    issuePublicationDate,
  } satisfies KohoCsvDocumentListProjection;
  return finalizeRecord(record);
}

function addDuplicateIssues(records: KohoCsvDocumentListRecord[]): void {
  const byPublication = new Map<string, KohoCsvDocumentListRecord[]>();
  for (const record of records) {
    const publicationNumber = record.sourceCells[1] ?? "";
    if (publicationNumber === "") continue;
    const matches = byPublication.get(publicationNumber) ?? [];
    matches.push(record);
    byPublication.set(publicationNumber, matches);
  }

  for (const matches of byPublication.values()) {
    if (matches.length < 2) continue;
    const firstKind = matches[0].sourceCells[2] ?? "";
    const firstDate = matches[0].sourceCells[3] ?? "";
    const hasConflict = matches.some(
      (record) =>
        (record.sourceCells[2] ?? "") !== firstKind ||
        (record.sourceCells[3] ?? "") !== firstDate,
    );
    for (const record of matches) {
      addIssueOnce(
        record.issues,
        createIssue("duplicate_publication_number", {
          recordOrdinal: record.ordinal,
          field: "publicationNumber",
        }),
      );
      if (hasConflict) {
        addIssueOnce(
          record.issues,
          createIssue("publication_record_conflict", {
            recordOrdinal: record.ordinal,
            field: "publicationNumber",
          }),
        );
      }
      finalizeRecord(record);
    }
  }
}

export function parseDocumentListRecords(
  input: ParseDocumentListInput,
): ParseDocumentListOutput {
  const issues: KohoCsvIssue[] = [];
  if (input.records.length === 0) {
    issues.push(createIssue("required_record_missing", { field: "records" }));
  }
  const records = input.records.map((record) =>
    parseRecord(record, input.packageType),
  );
  addDuplicateIssues(records);
  return {
    status: rollupFileStatus(issues, records),
    issues,
    records,
  };
}
