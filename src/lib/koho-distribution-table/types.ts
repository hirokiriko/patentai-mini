export type DistributionPackageType = "JPA" | "JPB";
export type DistributionDateRange = { from: string; to: string };

export type DistributionErrorCode =
  | "invalid_input" | "invalid_package_type" | "byte_limit_exceeded"
  | "missing_header" | "invalid_utf8" | "invalid_csv" | "invalid_header"
  | "column_count_mismatch" | "row_limit_exceeded" | "field_limit_exceeded"
  | "invalid_date" | "invalid_digits" | "invalid_availability"
  | "invalid_registration_range" | "invalid_number_list" | "duplicate_key"
  | "invalid_requested_range";

/** row=0 identifies the header; data rows are logical CSV records, starting at 1. */
export type DistributionError = { code: DistributionErrorCode; row?: number; column?: number };
export type DistributionWarning = {
  code: "missing_range_bound" | "reversed_number_range" | "duplicate_number"
    | "dates_out_of_order" | "no_observed_dates" | "requested_range_exceeds_observed_dates";
  row?: number;
  column?: number;
};

type NumberRange = { min: string | null; max: string | null };
type BaseRow = {
  ordinal: number;
  raw: readonly string[];
  publicationDate: string;
  publicationYear: string;
  annualIssue: string;
  cumulativeIssue: string;
  downloadAvailability: "available" | "unavailable";
  notes: string;
  warnings: DistributionWarning[];
};
export type DistributionRow = BaseRow & (
  | { packageType: "JPA"; publishedRange: NumberRange; translatedRange: NumberRange;
      dailyCounts: { published: number; translated: number } }
  | { packageType: "JPB"; patentRange: NumberRange; registrationDates: DistributionDateRange;
      skippedNumbers: string[]; recoveredNumbers: string[]; dailyCounts: { patents: number } }
);

export type DistributionTableResult =
  | { ok: false; error: DistributionError }
  | {
      ok: true;
      profileVersion: "jpo-2026-09-21";
      packageType: DistributionPackageType;
      /** Private caller provenance, not a hash published or signed by the distributor. */
      sourceSha256: string;
      sourceRowCount: number;
      observedDateRange: DistributionDateRange | null;
      requestedDateRange: DistributionDateRange | null;
      selectionMode: "date_range" | "all_observed_rows";
      selectionStatus: "no_rows_in_snapshot" | "rows_present";
      rows: DistributionRow[];
      counts: { selected: number; available: number; unavailable: number; warningRows: number };
      /** Includes source-row warnings outside the selected period. */
      warnings: DistributionWarning[];
      coverageProven: false;
      acquisitionState: "unknown";
      importState: "unknown";
    };
