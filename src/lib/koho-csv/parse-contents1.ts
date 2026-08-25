import { KNOWN_DISPLAY_FLAGS } from "./constants";
import {
  addIssueOnce,
  createIssue,
  finalizeRecord,
  rollupFileStatus,
} from "./issues";
import type {
  KohoCsvContents1Applicant,
  KohoCsvContents1Projection,
  KohoCsvContents1Record,
  KohoCsvDecimalValue,
  KohoCsvIssue,
  KohoCsvLimits,
  KohoCsvPackageType,
  KohoCsvStatus,
  ParsedCsvRecord,
} from "./types";

export interface ParseContents1Input {
  packageType: KohoCsvPackageType;
  records: readonly ParsedCsvRecord[];
  limits: KohoCsvLimits;
}

export interface ParseContents1Output {
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  issues: KohoCsvIssue[];
  records: KohoCsvContents1Record[];
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isValidDate(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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

function parseDecimal(
  sourceValue: string,
  record: KohoCsvContents1Record,
  field: string,
): KohoCsvDecimalValue | null {
  if (!/^[0-9]+$/.test(sourceValue)) {
    addIssueOnce(
      record.issues,
      createIssue("invalid_decimal", {
        recordOrdinal: record.ordinal,
        field,
      }),
    );
    return null;
  }

  const value = Number(sourceValue);
  if (!Number.isSafeInteger(value)) {
    addIssueOnce(
      record.issues,
      createIssue("invalid_decimal", {
        recordOrdinal: record.ordinal,
        field,
      }),
    );
    return null;
  }

  return { sourceValue, value };
}

function requireNonEmpty(
  value: string,
  record: KohoCsvContents1Record,
  field: string,
): void {
  if (value !== "") return;
  addIssueOnce(
    record.issues,
    createIssue("required_field_empty", {
      recordOrdinal: record.ordinal,
      field,
    }),
  );
}

function addRepeatedMismatch(record: KohoCsvContents1Record): void {
  addIssueOnce(
    record.issues,
    createIssue("repeated_cell_count_mismatch", {
      recordOrdinal: record.ordinal,
      field: "sourceCells",
    }),
  );
}

function enforceRepeatedLimit(
  decimal: KohoCsvDecimalValue,
  record: KohoCsvContents1Record,
  field: string,
  limit: number,
): boolean {
  if (decimal.value <= limit) return true;
  addIssueOnce(
    record.issues,
    createIssue("repeated_item_limit_exceeded", {
      recordOrdinal: record.ordinal,
      field,
    }),
  );
  return false;
}

function parseRecord(
  parsed: ParsedCsvRecord,
  packageType: KohoCsvPackageType,
  limits: KohoCsvLimits,
): KohoCsvContents1Record {
  const record: KohoCsvContents1Record = {
    ordinal: parsed.ordinal,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    rawRecord: parsed.rawRecord,
    sourceCells: [...parsed.sourceCells],
    projection: null,
    status: "success",
    issues: [],
  };

  if (parsed.rawRecord === "") {
    record.issues.push(
      createIssue("empty_record", { recordOrdinal: record.ordinal }),
    );
    return finalizeRecord(record);
  }

  const cells = parsed.sourceCells;
  let cursor = 0;
  let structuralFailure = false;
  const takeCell = (): string | null => {
    if (cursor >= cells.length) {
      structuralFailure = true;
      return null;
    }
    const value = cells[cursor];
    cursor += 1;
    return value;
  };

  const takeDecimal = (field: string): KohoCsvDecimalValue | null => {
    const sourceValue = takeCell();
    if (sourceValue === null) return null;
    return parseDecimal(sourceValue, record, field);
  };

  const recordCharacterLength = takeDecimal("recordCharacterLength");
  const divisionSectionCode = takeCell();
  const formattedPublicationNumber = takeCell();
  const registrationDate = packageType === "JPB" ? takeCell() : null;
  const formattedApplicationNumber = takeCell();
  const displayFlagCount = takeDecimal("displayFlagCount");

  if (structuralFailure) {
    addRepeatedMismatch(record);
    return finalizeRecord(record);
  }

  requireNonEmpty(divisionSectionCode!, record, "divisionSectionCode");
  requireNonEmpty(
    formattedPublicationNumber!,
    record,
    "formattedPublicationNumber",
  );
  requireNonEmpty(
    formattedApplicationNumber!,
    record,
    "formattedApplicationNumber",
  );
  if (packageType === "JPB" && !isValidDate(registrationDate!)) {
    addIssueOnce(
      record.issues,
      createIssue("invalid_date", {
        recordOrdinal: record.ordinal,
        field: "registrationDate",
      }),
    );
  }

  if (
    displayFlagCount === null ||
    !enforceRepeatedLimit(
      displayFlagCount,
      record,
      "displayFlagCount",
      limits.maxRepeatedItemsPerRecord,
    )
  ) {
    return finalizeRecord(record);
  }

  const displayFlags: string[] = [];
  for (let index = 0; index < displayFlagCount.value; index += 1) {
    const displayFlag = takeCell();
    if (displayFlag === null) break;
    displayFlags.push(displayFlag);
    requireNonEmpty(displayFlag, record, `displayFlags[${index}]`);
    if (
      displayFlag !== "" &&
      !KNOWN_DISPLAY_FLAGS[packageType].has(displayFlag)
    ) {
      addIssueOnce(
        record.issues,
        createIssue("unknown_display_flag", {
          recordOrdinal: record.ordinal,
          field: `displayFlags[${index}]`,
        }),
      );
    }
  }

  if (structuralFailure) {
    addRepeatedMismatch(record);
    return finalizeRecord(record);
  }

  const displayClassificationCount = takeDecimal(
    "displayClassificationCount",
  );
  if (
    displayClassificationCount === null ||
    !enforceRepeatedLimit(
      displayClassificationCount,
      record,
      "displayClassificationCount",
      limits.maxRepeatedItemsPerRecord,
    )
  ) {
    return finalizeRecord(record);
  }

  const displayClassifications: string[] = [];
  for (
    let index = 0;
    index < displayClassificationCount.value;
    index += 1
  ) {
    const displayClassification = takeCell();
    if (displayClassification === null) break;
    displayClassifications.push(displayClassification);
    requireNonEmpty(
      displayClassification,
      record,
      `displayClassifications[${index}]`,
    );
  }

  if (structuralFailure) {
    addRepeatedMismatch(record);
    return finalizeRecord(record);
  }

  const titleCharacterLength = takeDecimal("titleCharacterLength");
  const title = takeCell();
  const applicantCount = takeDecimal("applicantCount");
  if (structuralFailure) {
    addRepeatedMismatch(record);
    return finalizeRecord(record);
  }

  if (title === "") {
    addIssueOnce(
      record.issues,
      createIssue("empty_title", {
        recordOrdinal: record.ordinal,
        field: "title",
      }),
    );
  }

  const computedRecordCharacterLength = codePointLength(parsed.rawRecord) + 1;
  if (
    recordCharacterLength !== null &&
    recordCharacterLength.value !== computedRecordCharacterLength
  ) {
    addIssueOnce(
      record.issues,
      createIssue("character_length_mismatch", {
        recordOrdinal: record.ordinal,
        field: "recordCharacterLength",
      }),
    );
  }
  if (
    titleCharacterLength !== null &&
    title !== null &&
    titleCharacterLength.value !== codePointLength(title)
  ) {
    addIssueOnce(
      record.issues,
      createIssue("character_length_mismatch", {
        recordOrdinal: record.ordinal,
        field: "titleCharacterLength",
      }),
    );
  }

  if (
    applicantCount === null ||
    !enforceRepeatedLimit(
      applicantCount,
      record,
      "applicantCount",
      limits.maxRepeatedItemsPerRecord,
    )
  ) {
    return finalizeRecord(record);
  }

  const applicants: KohoCsvContents1Applicant[] = [];
  let applicantDecimalFailure = false;
  for (let index = 0; index < applicantCount.value; index += 1) {
    const locationCharacterLength = takeDecimal(
      `applicants[${index}].locationCharacterLength`,
    );
    const location = takeCell();
    const partyIdentifier = takeCell();
    const applicantNameCharacterLength = takeDecimal(
      `applicants[${index}].applicantNameCharacterLength`,
    );
    const applicantName = takeCell();

    if (structuralFailure) break;
    if (applicantName === "") {
      addIssueOnce(
        record.issues,
        createIssue("empty_applicant_name", {
          recordOrdinal: record.ordinal,
          field: `applicants[${index}].applicantName`,
        }),
      );
    }
    if (
      locationCharacterLength === null ||
      applicantNameCharacterLength === null
    ) {
      applicantDecimalFailure = true;
      continue;
    }

    if (locationCharacterLength.value !== codePointLength(location!)) {
      addIssueOnce(
        record.issues,
        createIssue("character_length_mismatch", {
          recordOrdinal: record.ordinal,
          field: `applicants[${index}].locationCharacterLength`,
        }),
      );
    }
    if (
      applicantNameCharacterLength.value !== codePointLength(applicantName!)
    ) {
      addIssueOnce(
        record.issues,
        createIssue("character_length_mismatch", {
          recordOrdinal: record.ordinal,
          field: `applicants[${index}].applicantNameCharacterLength`,
        }),
      );
    }

    applicants.push({
      locationCharacterLength,
      location: location!,
      partyIdentifier: {
        sourceValue: partyIdentifier!,
        value: partyIdentifier === "" ? null : partyIdentifier!,
      },
      applicantNameCharacterLength,
      applicantName: applicantName!,
    });
  }

  if (structuralFailure || cursor !== cells.length) {
    addRepeatedMismatch(record);
  }

  if (
    !structuralFailure &&
    !applicantDecimalFailure &&
    cursor === cells.length &&
    recordCharacterLength !== null &&
    titleCharacterLength !== null &&
    applicantCount !== null
  ) {
    const projection: KohoCsvContents1Projection = {
      recordCharacterLength,
      computedRecordCharacterLength,
      divisionSectionCode: divisionSectionCode!,
      formattedPublicationNumber: formattedPublicationNumber!,
      registrationDate,
      formattedApplicationNumber: formattedApplicationNumber!,
      displayFlagCount,
      displayFlags,
      displayClassificationCount,
      displayClassifications,
      titleCharacterLength,
      title: title!,
      applicantCount,
      applicants,
    };
    record.projection = projection;
  }

  return finalizeRecord(record);
}

function markDuplicatePublicationNumbers(
  records: KohoCsvContents1Record[],
): void {
  const recordsByPublicationNumber = new Map<
    string,
    KohoCsvContents1Record[]
  >();

  for (const record of records) {
    const publicationNumber = record.sourceCells[2];
    if (publicationNumber === undefined || publicationNumber === "") continue;
    const group = recordsByPublicationNumber.get(publicationNumber) ?? [];
    group.push(record);
    recordsByPublicationNumber.set(publicationNumber, group);
  }

  for (const group of recordsByPublicationNumber.values()) {
    if (group.length < 2) continue;
    for (const record of group) {
      addIssueOnce(
        record.issues,
        createIssue("duplicate_publication_number", {
          recordOrdinal: record.ordinal,
          field: "formattedPublicationNumber",
        }),
      );
      finalizeRecord(record);
    }
  }
}

export function parseContents1Records(
  input: ParseContents1Input,
): ParseContents1Output {
  const issues: KohoCsvIssue[] = [];
  if (input.records.length === 0) {
    issues.push(createIssue("required_record_missing"));
  }

  const records = input.records.map((record) =>
    parseRecord(record, input.packageType, input.limits),
  );
  markDuplicatePublicationNumbers(records);

  return {
    status: rollupFileStatus(issues, records),
    issues,
    records,
  };
}
