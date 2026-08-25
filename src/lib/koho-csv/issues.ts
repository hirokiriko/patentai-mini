import type {
  KohoCsvIssue,
  KohoCsvIssueCode,
  KohoCsvRecord,
  KohoCsvStatus,
} from "./types";

const ISSUE_DEFINITIONS: Record<
  KohoCsvIssueCode,
  {
    status: Exclude<KohoCsvStatus, "success">;
    message: string;
  }
> = {
  invalid_limits: {
    status: "failed",
    message: "CSV limits are invalid",
  },
  unsafe_entry_path: {
    status: "failed",
    message: "CSV entry path is unsafe",
  },
  package_section_mismatch: {
    status: "failed",
    message: "CSV package type conflicts with the entry section",
  },
  csv_byte_limit_exceeded: {
    status: "failed",
    message: "CSV bytes exceed the configured limit",
  },
  unsupported_logical_file: {
    status: "unsupported_type",
    message: "CSV logical file is not supported",
  },
  unsupported_entry_placement: {
    status: "unsupported_type",
    message: "CSV entry placement is not supported",
  },
  invalid_utf8: {
    status: "failed",
    message: "CSV is not valid UTF-8",
  },
  utf8_bom_present: {
    status: "review_required",
    message: "CSV contains an unobserved UTF-8 BOM",
  },
  unobserved_line_ending: {
    status: "review_required",
    message: "CSV contains an unobserved line ending",
  },
  missing_terminal_crlf: {
    status: "review_required",
    message: "CSV does not end with CRLF",
  },
  csv_syntax_error: {
    status: "failed",
    message: "CSV syntax is invalid",
  },
  empty_file: {
    status: "failed",
    message: "CSV file is empty",
  },
  empty_record: {
    status: "failed",
    message: "CSV contains an empty logical record",
  },
  required_record_missing: {
    status: "failed",
    message: "CSV is missing a required record",
  },
  record_limit_exceeded: {
    status: "failed",
    message: "CSV record count exceeds the configured limit",
  },
  column_limit_exceeded: {
    status: "failed",
    message: "CSV column count exceeds the configured limit",
  },
  cell_character_limit_exceeded: {
    status: "failed",
    message: "CSV cell characters exceed the configured limit",
  },
  total_character_limit_exceeded: {
    status: "failed",
    message: "CSV total characters exceed the configured limit",
  },
  column_count_mismatch: {
    status: "failed",
    message: "CSV record column count is invalid",
  },
  required_field_empty: {
    status: "failed",
    message: "CSV required field is empty",
  },
  invalid_date: {
    status: "failed",
    message: "CSV date is invalid",
  },
  invalid_decimal: {
    status: "failed",
    message: "CSV decimal value is invalid",
  },
  repeated_item_limit_exceeded: {
    status: "failed",
    message: "CSV repeated item count exceeds the configured limit",
  },
  repeated_cell_count_mismatch: {
    status: "failed",
    message: "CSV repeated item count does not match its cells",
  },
  character_length_mismatch: {
    status: "failed",
    message: "CSV character length does not match its source value",
  },
  package_code_mismatch: {
    status: "failed",
    message: "CSV package code conflicts with the input package type",
  },
  unknown_section: {
    status: "review_required",
    message: "CSV section name is not recognized",
  },
  duplicate_section: {
    status: "review_required",
    message: "CSV contains a duplicate section",
  },
  invalid_semicolon_list: {
    status: "failed",
    message: "CSV semicolon list contains an empty item",
  },
  unknown_country_code: {
    status: "review_required",
    message: "CSV country code is not recognized",
  },
  unknown_kind: {
    status: "review_required",
    message: "CSV kind code is not recognized",
  },
  package_kind_mismatch: {
    status: "failed",
    message: "CSV kind code conflicts with the input package type",
  },
  duplicate_publication_number: {
    status: "review_required",
    message: "CSV contains a duplicate publication number",
  },
  publication_record_conflict: {
    status: "review_required",
    message: "CSV publication records conflict",
  },
  empty_title: {
    status: "review_required",
    message: "CSV title is empty",
  },
  empty_applicant_name: {
    status: "review_required",
    message: "CSV applicant name is empty",
  },
  unknown_display_flag: {
    status: "review_required",
    message: "CSV display flag is not recognized",
  },
  display_slot_mismatch: {
    status: "failed",
    message: "CSV display flag count does not match its slots",
  },
  jpb_record_length_unverified: {
    status: "review_required",
    message: "JPB CSV record length calculation is unverified",
  },
};

export function createIssue(
  code: KohoCsvIssueCode,
  context: {
    recordOrdinal?: number;
    field?: string;
  } = {},
): KohoCsvIssue {
  const definition = ISSUE_DEFINITIONS[code];
  return {
    code,
    status: definition.status,
    message: definition.message,
    ...(context.recordOrdinal === undefined
      ? {}
      : { recordOrdinal: context.recordOrdinal }),
    ...(context.field === undefined ? {} : { field: context.field }),
  };
}

export function addIssueOnce(
  issues: KohoCsvIssue[],
  issue: KohoCsvIssue,
): void {
  if (
    issues.some(
      (existing) =>
        existing.code === issue.code &&
        existing.recordOrdinal === issue.recordOrdinal &&
        existing.field === issue.field,
    )
  ) {
    return;
  }
  issues.push(issue);
}

export function rollupRecordStatus(
  issues: readonly KohoCsvIssue[],
): Exclude<KohoCsvStatus, "unsupported_type"> {
  if (issues.some((issue) => issue.status === "failed")) return "failed";
  if (issues.some((issue) => issue.status === "review_required")) {
    return "review_required";
  }
  return "success";
}

export function finalizeRecord<TProjection>(
  record: KohoCsvRecord<TProjection>,
): KohoCsvRecord<TProjection> {
  record.status = rollupRecordStatus(record.issues);
  if (record.status === "failed") {
    record.projection = null;
  }
  return record;
}

export function rollupFileStatus(
  issues: readonly KohoCsvIssue[],
  records: readonly KohoCsvRecord<unknown>[],
): Exclude<KohoCsvStatus, "unsupported_type"> {
  if (
    issues.some((issue) => issue.status === "failed") ||
    records.some((record) => record.status === "failed")
  ) {
    return "failed";
  }
  if (
    issues.some((issue) => issue.status === "review_required") ||
    records.some((record) => record.status === "review_required")
  ) {
    return "review_required";
  }
  return "success";
}
