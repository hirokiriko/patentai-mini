import { KNOWN_DISPLAY_FLAGS } from "./constants";
import {
  addIssueOnce,
  createIssue,
  finalizeRecord,
  rollupFileStatus,
} from "./issues";
import type {
  KohoCsvContents2Projection,
  KohoCsvContents2Record,
  KohoCsvDecimalValue,
  KohoCsvIssue,
  KohoCsvLimits,
  KohoCsvOptionalString,
  KohoCsvPackageType,
  KohoCsvStatus,
  ParsedCsvRecord,
} from "./types";

export interface ParseContents2Input {
  packageType: KohoCsvPackageType;
  records: readonly ParsedCsvRecord[];
  limits: KohoCsvLimits;
}

export interface ParseContents2Output {
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  issues: KohoCsvIssue[];
  records: KohoCsvContents2Record[];
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function optionalString(sourceValue: string): KohoCsvOptionalString {
  return {
    sourceValue,
    value: sourceValue === "" ? null : sourceValue,
  };
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
  record: KohoCsvContents2Record,
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
  record: KohoCsvContents2Record,
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

function parseRecord(
  parsed: ParsedCsvRecord,
  packageType: KohoCsvPackageType,
): KohoCsvContents2Record {
  const record: KohoCsvContents2Record = {
    ordinal: parsed.ordinal,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    rawRecord: parsed.rawRecord,
    sourceCells: [...parsed.sourceCells],
    projection: null,
    status: "success",
    issues: [],
  };

  if (packageType === "JPB") {
    record.issues.push(
      createIssue("jpb_record_length_unverified", {
        recordOrdinal: record.ordinal,
        field: "recordLength",
      }),
    );
  }

  if (parsed.rawRecord === "") {
    record.issues.push(
      createIssue("empty_record", { recordOrdinal: record.ordinal }),
    );
    return finalizeRecord(record);
  }

  const expectedColumns = packageType === "JPA" ? 17 : 18;
  if (parsed.sourceCells.length !== expectedColumns) {
    record.issues.push(
      createIssue("column_count_mismatch", {
        recordOrdinal: record.ordinal,
        field: "sourceCells",
      }),
    );
    return finalizeRecord(record);
  }

  const cells = parsed.sourceCells;
  const registrationOffset = packageType === "JPB" ? 1 : 0;
  const recordLength = parseDecimal(cells[0], record, "recordLength");
  const divisionSectionCode = cells[1];
  const publicationNumber = cells[2];
  const registrationDate = packageType === "JPB" ? cells[3] : null;
  const applicationNumber = cells[3 + registrationOffset];
  const displayFlagCount = parseDecimal(
    cells[4 + registrationOffset],
    record,
    "displayFlagCount",
  );
  const slots = cells.slice(5 + registrationOffset, 12 + registrationOffset);
  const firstClassification = cells[12 + registrationOffset];
  const title = cells[13 + registrationOffset];
  const firstApplicantLocation = cells[14 + registrationOffset];
  const firstPartyIdentifier = cells[15 + registrationOffset];
  const firstApplicantName = cells[16 + registrationOffset];

  requireNonEmpty(divisionSectionCode, record, "divisionSectionCode");
  requireNonEmpty(publicationNumber, record, "publicationNumber");
  requireNonEmpty(applicationNumber, record, "applicationNumber");
  if (packageType === "JPB" && !isValidDate(registrationDate!)) {
    addIssueOnce(
      record.issues,
      createIssue("invalid_date", {
        recordOrdinal: record.ordinal,
        field: "registrationDate",
      }),
    );
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

  const displayFlags: string[] = [];
  if (displayFlagCount !== null) {
    if (displayFlagCount.value > 7) {
      addIssueOnce(
        record.issues,
        createIssue("display_slot_mismatch", {
          recordOrdinal: record.ordinal,
          field: "displayFlagCount",
        }),
      );
    } else {
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        if (index < displayFlagCount.value) {
          if (slot === "" || slot === " ") {
            addIssueOnce(
              record.issues,
              createIssue("display_slot_mismatch", {
                recordOrdinal: record.ordinal,
                field: `displaySlot${index + 1}`,
              }),
            );
            continue;
          }
          displayFlags.push(slot);
          if (!KNOWN_DISPLAY_FLAGS[packageType].has(slot)) {
            addIssueOnce(
              record.issues,
              createIssue("unknown_display_flag", {
                recordOrdinal: record.ordinal,
                field: `displaySlot${index + 1}`,
              }),
            );
          }
        } else if (slot !== " ") {
          addIssueOnce(
            record.issues,
            createIssue("display_slot_mismatch", {
              recordOrdinal: record.ordinal,
              field: `displaySlot${index + 1}`,
            }),
          );
        }
      }
    }
  }

  const computedRecordLength = codePointLength(parsed.rawRecord) + 1;
  const matchesCandidate =
    recordLength !== null && recordLength.value === computedRecordLength;
  if (
    packageType === "JPA" &&
    recordLength !== null &&
    !matchesCandidate
  ) {
    addIssueOnce(
      record.issues,
      createIssue("character_length_mismatch", {
        recordOrdinal: record.ordinal,
        field: "recordLength",
      }),
    );
  }

  if (recordLength !== null && displayFlagCount !== null) {
    const projection: KohoCsvContents2Projection = {
      recordLength,
      computedRecordLength,
      matchesCandidate,
      divisionSectionCode,
      publicationNumber,
      registrationDate,
      applicationNumber,
      displayFlagCount,
      displaySlot1: slots[0],
      displaySlot2: slots[1],
      displaySlot3: slots[2],
      displaySlot4: slots[3],
      displaySlot5: slots[4],
      displaySlot6: slots[5],
      displaySlot7: slots[6],
      displayFlags,
      firstClassification: optionalString(firstClassification),
      title,
      firstApplicantLocation: optionalString(firstApplicantLocation),
      firstPartyIdentifier: optionalString(firstPartyIdentifier),
      firstApplicantName: optionalString(firstApplicantName),
      projectionCompleteness: "lossy_first_values_only",
    };
    record.projection = projection;
  }

  return finalizeRecord(record);
}

function markDuplicatePublicationNumbers(
  records: KohoCsvContents2Record[],
): void {
  const recordsByPublicationNumber = new Map<
    string,
    KohoCsvContents2Record[]
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
          field: "publicationNumber",
        }),
      );
      finalizeRecord(record);
    }
  }
}

export function parseContents2Records(
  input: ParseContents2Input,
): ParseContents2Output {
  const issues: KohoCsvIssue[] = [];
  if (input.records.length === 0) {
    issues.push(createIssue("required_record_missing"));
  }

  const records = input.records.map((record) =>
    parseRecord(record, input.packageType),
  );
  markDuplicatePublicationNumbers(records);

  return {
    status: rollupFileStatus(issues, records),
    issues,
    records,
  };
}
