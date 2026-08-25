import { describe, expect, it } from "vitest";

import {
  createIssue,
  rollupFileStatus,
  rollupRecordStatus,
} from "./issues";
import type {
  KohoCsvIssueCode,
  KohoCsvStatus,
} from "./types";

const CASES = [
  ["invalid_limits", "failed"],
  ["unsafe_entry_path", "failed"],
  ["package_section_mismatch", "failed"],
  ["csv_byte_limit_exceeded", "failed"],
  ["unsupported_logical_file", "unsupported_type"],
  ["unsupported_entry_placement", "unsupported_type"],
  ["invalid_utf8", "failed"],
  ["utf8_bom_present", "review_required"],
  ["unobserved_line_ending", "review_required"],
  ["missing_terminal_crlf", "review_required"],
  ["csv_syntax_error", "failed"],
  ["empty_file", "failed"],
  ["empty_record", "failed"],
  ["required_record_missing", "failed"],
  ["record_limit_exceeded", "failed"],
  ["column_limit_exceeded", "failed"],
  ["cell_character_limit_exceeded", "failed"],
  ["total_character_limit_exceeded", "failed"],
  ["column_count_mismatch", "failed"],
  ["required_field_empty", "failed"],
  ["invalid_date", "failed"],
  ["invalid_decimal", "failed"],
  ["repeated_item_limit_exceeded", "failed"],
  ["repeated_cell_count_mismatch", "failed"],
  ["character_length_mismatch", "failed"],
  ["package_code_mismatch", "failed"],
  ["unknown_section", "review_required"],
  ["duplicate_section", "review_required"],
  ["invalid_semicolon_list", "failed"],
  ["unknown_country_code", "review_required"],
  ["unknown_kind", "review_required"],
  ["package_kind_mismatch", "failed"],
  ["duplicate_publication_number", "review_required"],
  ["publication_record_conflict", "review_required"],
  ["empty_title", "review_required"],
  ["empty_applicant_name", "review_required"],
  ["unknown_display_flag", "review_required"],
  ["display_slot_mismatch", "failed"],
  ["jpb_record_length_unverified", "review_required"],
] as const satisfies ReadonlyArray<
  [KohoCsvIssueCode, Exclude<KohoCsvStatus, "success">]
>;

describe("Koho CSV stable issues", () => {
  it("39 codeを重複なく保持する", () => {
    expect(CASES).toHaveLength(39);
    expect(new Set(CASES.map(([code]) => code)).size).toBe(39);
  });

  it.each(CASES)("%sを%sへ固定mappingする", (code, status) => {
    const issue = createIssue(code, {
      recordOrdinal: 7,
      field: "fictionalField",
    });

    expect(issue).toEqual({
      code,
      status,
      message: expect.any(String),
      recordOrdinal: 7,
      field: "fictionalField",
    });
    expect(issue.message.length).toBeGreaterThan(0);
  });

  it("record/file statusをfailed > review_required > successで集約する", () => {
    const review = createIssue("unknown_kind");
    const failed = createIssue("invalid_date");

    expect(rollupRecordStatus([])).toBe("success");
    expect(rollupRecordStatus([review])).toBe("review_required");
    expect(rollupRecordStatus([review, failed])).toBe("failed");
    expect(rollupFileStatus([review], [])).toBe("review_required");
    expect(rollupFileStatus([review, failed], [])).toBe("failed");
  });
});
