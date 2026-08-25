import { ABSTRACT_SECTION_NAMES } from "./constants";
import {
  addIssueOnce,
  createIssue,
  finalizeRecord,
  rollupFileStatus,
} from "./issues";
import type {
  KohoCsvAbstractProjection,
  KohoCsvAbstractRecord,
  KohoCsvIssue,
  KohoCsvPackageType,
  ParsedCsvRecord,
} from "./types";

export interface ParseAbstractInput {
  packageType: KohoCsvPackageType;
  records: ParsedCsvRecord[];
}

export interface ParseAbstractOutput {
  status: "success" | "review_required" | "failed";
  issues: KohoCsvIssue[];
  records: KohoCsvAbstractRecord[];
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

function documentCount(sourceValue: string) {
  if (!/^[0-9]{5}$/.test(sourceValue)) return null;
  const value = Number(sourceValue);
  return Number.isSafeInteger(value) ? { sourceValue, value } : null;
}

function semicolonList(sourceValue: string): {
  sourceValue: string;
  values: string[];
  valid: boolean;
} {
  if (sourceValue === "") return { sourceValue, values: [], valid: true };
  const values = sourceValue.split(";");
  return {
    sourceValue,
    values,
    valid: values.every((value) => value !== ""),
  };
}

function recordShell<TProjection>(
  parsed: ParsedCsvRecord,
): {
  record: KohoCsvAbstractRecord;
  setProjection: (projection: TProjection) => void;
} {
  const record: KohoCsvAbstractRecord = {
    ordinal: parsed.ordinal,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    rawRecord: parsed.rawRecord,
    sourceCells: parsed.sourceCells,
    projection: null,
    status: "success",
    issues: [],
  };
  return {
    record,
    setProjection: (projection) => {
      record.projection = projection as KohoCsvAbstractProjection;
    },
  };
}

function parseMetadata(
  parsed: ParsedCsvRecord,
  packageType: KohoCsvPackageType,
): KohoCsvAbstractRecord {
  const { record, setProjection } =
    recordShell<KohoCsvAbstractProjection>(parsed);
  const [packageCode = "", publicationDate = "", issueNumber = "", issueControlValue = ""] =
    parsed.sourceCells;

  if (parsed.rawRecord === "") {
    record.issues.push(createIssue("empty_record", { recordOrdinal: parsed.ordinal }));
  }
  if (parsed.sourceCells.length !== 4) {
    record.issues.push(
      createIssue("column_count_mismatch", {
        recordOrdinal: parsed.ordinal,
        field: "metadata",
      }),
    );
  }
  if (packageCode !== packageType) {
    record.issues.push(
      createIssue("package_code_mismatch", {
        recordOrdinal: parsed.ordinal,
        field: "packageCode",
      }),
    );
  }
  if (!isGregorianDate(publicationDate)) {
    record.issues.push(
      createIssue("invalid_date", {
        recordOrdinal: parsed.ordinal,
        field: "publicationDate",
      }),
    );
  }
  for (const [value, field] of [
    [issueNumber, "issueNumber"],
    [issueControlValue, "issueControlValue"],
  ] as const) {
    if (value === "") {
      record.issues.push(
        createIssue("required_field_empty", {
          recordOrdinal: parsed.ordinal,
          field,
        }),
      );
    }
  }

  setProjection({
    recordType: "metadata",
    packageCode,
    publicationDate,
    issueNumber,
    issueControlValue,
  });
  return finalizeRecord(record);
}

function parseSummary(
  parsed: ParsedCsvRecord,
  packageType: KohoCsvPackageType,
): KohoCsvAbstractRecord {
  const { record, setProjection } =
    recordShell<KohoCsvAbstractProjection>(parsed);
  const expectedColumns = packageType === "JPA" ? 3 : 5;
  const [sectionName = "", publicationNumberRange = "", countText = ""] =
    parsed.sourceCells;
  const normalizedSectionName = sectionName.replace(/ +$/u, "");
  const knownSections = ABSTRACT_SECTION_NAMES[packageType];
  const section = Object.hasOwn(knownSections, normalizedSectionName)
    ? knownSections[normalizedSectionName]
    : null;
  const parsedDocumentCount = documentCount(countText);
  const missing = semicolonList(parsed.sourceCells[3] ?? "");
  const included = semicolonList(parsed.sourceCells[4] ?? "");

  if (parsed.rawRecord === "") {
    record.issues.push(createIssue("empty_record", { recordOrdinal: parsed.ordinal }));
  }
  if (parsed.sourceCells.length !== expectedColumns) {
    record.issues.push(
      createIssue("column_count_mismatch", {
        recordOrdinal: parsed.ordinal,
        field: "summary",
      }),
    );
  }
  if (sectionName === "") {
    record.issues.push(
      createIssue("required_field_empty", {
        recordOrdinal: parsed.ordinal,
        field: "sectionName",
      }),
    );
  }
  if (section === null) {
    record.issues.push(
      createIssue("unknown_section", {
        recordOrdinal: parsed.ordinal,
        field: "sectionName",
      }),
    );
  }
  if (publicationNumberRange === "") {
    record.issues.push(
      createIssue("required_field_empty", {
        recordOrdinal: parsed.ordinal,
        field: "publicationNumberRange",
      }),
    );
  }
  if (parsedDocumentCount === null) {
    record.issues.push(
      createIssue("invalid_decimal", {
        recordOrdinal: parsed.ordinal,
        field: "documentCount",
      }),
    );
  }
  if (packageType === "JPB") {
    if (!missing.valid) {
      record.issues.push(
        createIssue("invalid_semicolon_list", {
          recordOrdinal: parsed.ordinal,
          field: "missingNumbersInRange",
        }),
      );
    }
    if (!included.valid) {
      record.issues.push(
        createIssue("invalid_semicolon_list", {
          recordOrdinal: parsed.ordinal,
          field: "includedNumbersOutsideRange",
        }),
      );
    }
  }

  setProjection({
    recordType: "summary",
    sectionName,
    normalizedSectionName,
    section,
    publicationNumberRange,
    documentCount: parsedDocumentCount ?? { sourceValue: countText, value: 0 },
    missingNumbersInRange:
      packageType === "JPB"
        ? { sourceValue: missing.sourceValue, values: missing.values }
        : null,
    includedNumbersOutsideRange:
      packageType === "JPB"
        ? { sourceValue: included.sourceValue, values: included.values }
        : null,
  });
  return finalizeRecord(record);
}

function addDuplicateSectionIssues(records: KohoCsvAbstractRecord[]): void {
  const bySection = new Map<string, KohoCsvAbstractRecord[]>();
  for (const record of records.slice(1)) {
    const normalized = record.sourceCells[0] ?? "";
    const key = normalized.replace(/ +$/u, "");
    const matches = bySection.get(key) ?? [];
    matches.push(record);
    bySection.set(key, matches);
  }
  for (const matches of bySection.values()) {
    if (matches.length < 2) continue;
    for (const record of matches) {
      addIssueOnce(
        record.issues,
        createIssue("duplicate_section", {
          recordOrdinal: record.ordinal,
          field: "sectionName",
        }),
      );
      finalizeRecord(record);
    }
  }
}

export function parseAbstractRecords(
  input: ParseAbstractInput,
): ParseAbstractOutput {
  const issues: KohoCsvIssue[] = [];
  if (input.records.length === 0) {
    issues.push(createIssue("required_record_missing", { field: "metadata" }));
  }
  if (input.records.length < 2) {
    issues.push(createIssue("required_record_missing", { field: "summary" }));
  }
  const records = input.records.map((record, index) =>
    index === 0
      ? parseMetadata(record, input.packageType)
      : parseSummary(record, input.packageType),
  );
  addDuplicateSectionIssues(records);
  return {
    status: rollupFileStatus(issues, records),
    issues,
    records,
  };
}
