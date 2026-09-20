import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DISTRIBUTION_HEADERS, DISTRIBUTION_LIMITS, parseDistributionTable } from "./index";
import type { DistributionPackageType, DistributionTableResult } from "./types";

// Entirely fictional metadata, generated independently of any downloaded snapshot.
function row(index = 0, type: DistributionPackageType = "JPA"): string[] {
  const date = new Date(Date.UTC(2092, 0, 1) + index * 86_400_000);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const annual = String((date.getTime() - yearStart) / 86_400_000 + 1).padStart(3, "0");
  const common = [date.toISOString().slice(0, 10).replaceAll("-", ""), annual, String(index + 1).padStart(5, "0")];
  return type === "JPA"
    ? [...common, "001100", "001108", "501100", "501103", "00003", "00002", "可", ""]
    : [...common, "9000100", "9000108", "20911230", "9000103;9000105", "8000100", "00004", "可", ""];
}
const field = (value: string) => `"${value.replaceAll('"', '""')}"`;
function csv(rows: readonly (readonly string[])[], type: DistributionPackageType = "JPA", newline = "\n", bom = true): Uint8Array {
  const records = [DISTRIBUTION_HEADERS[type], ...rows];
  return new TextEncoder().encode((bom ? "\uFEFF" : "") + records.map(r => r.map(field).join(",")).join(newline) + newline);
}
function success(value: DistributionTableResult) {
  expect(value.ok).toBe(true);
  if (!value.ok) throw new Error(value.error.code);
  return value;
}
function failure(bytes: Uint8Array, code: string, type: DistributionPackageType = "JPA") {
  const result = parseDistributionTable({ bytes, packageType: type });
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(result).not.toHaveProperty("rows");
  return result;
}

describe("observed JPO distribution table profile", () => {
  it("preserves raw identifiers and separates unavailable rows from acquisition/import evidence", () => {
    const first = row(), second = row(1); second[9] = "不可";
    const bytes = csv([first, second]), before = bytes.slice();
    const input = Object.freeze({ bytes, packageType: "JPA" as const });
    const result = success(parseDistributionTable(input));
    expect(result).toMatchObject({ profileVersion: "jpo-2026-09-21", packageType: "JPA", sourceRowCount: 2,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      observedDateRange: { from: "2092-01-01", to: "2092-01-02" }, requestedDateRange: null,
      selectionMode: "all_observed_rows", selectionStatus: "rows_present",
      counts: { selected: 2, available: 1, unavailable: 1, warningRows: 0 },
      coverageProven: false, acquisitionState: "unknown", importState: "unknown" });
    expect(result.rows[0]).toMatchObject({ ordinal: 1, annualIssue: "001", cumulativeIssue: "00001",
      publicationYear: "2092", publishedRange: { min: "001100", max: "001108" },
      dailyCounts: { published: 3, translated: 2 }, raw: first });
    expect(result.rows[1].downloadAvailability).toBe("unavailable");
    expect(bytes).toEqual(before);
    expect(parseDistributionTable(input)).toEqual(result);
  });

  it("keeps blank bounds with positive counts, and reports one-sided/reversed bounds without repair", () => {
    const values = row(); values[3] = ""; values[5] = ""; values[6] = "";
    const reverse = row(1); reverse[3] = "001200"; reverse[4] = "001100";
    const result = success(parseDistributionTable({ bytes: csv([values, reverse]), packageType: "JPA" }));
    expect(result.rows[0]).toMatchObject({ translatedRange: { min: null, max: null }, dailyCounts: { translated: 2 },
      publishedRange: { min: null, max: "001108" }, warnings: [{ code: "missing_range_bound", row: 1, column: 4 }] });
    expect(result.rows[1]).toMatchObject({ publishedRange: { min: "001200", max: "001100" },
      warnings: [{ code: "reversed_number_range", row: 2, column: 4 }] });
    expect(result.counts.warningRows).toBe(2);
  });

  it("normalizes JPB registration ranges and keeps skipped/recovered order and duplicate warnings", () => {
    const single = row(0, "JPB"), range = row(1, "JPB");
    range[5] = "20911229～20911230";
    range[6] = "9000103;9000103";
    range[7] = Array.from({ length: 1500 }, (_, i) => String(8000000 + i)).join(";");
    const result = success(parseDistributionTable({ bytes: csv([single, range], "JPB"), packageType: "JPB" }));
    expect(result.rows[0]).toMatchObject({ registrationDates: { from: "2091-12-30", to: "2091-12-30" },
      skippedNumbers: ["9000103", "9000105"], dailyCounts: { patents: 4 } });
    expect(result.rows[1]).toMatchObject({ registrationDates: { from: "2091-12-29", to: "2091-12-30" },
      skippedNumbers: ["9000103", "9000103"], warnings: [{ code: "duplicate_number", row: 2, column: 7 }] });
    if (result.rows[1].packageType === "JPB") expect(result.rows[1].recoveredNumbers).toHaveLength(1500);
  });

  it.each(["\n", "\r\n"])("preserves quoted fields and logical ordinals with %j", newline => {
    const values = row(); values[10] = `架空,備考"例"${newline}=1+1`;
    const result = success(parseDistributionTable({ bytes: csv([values, row(1)], "JPA", newline, false), packageType: "JPA" }));
    expect(result.rows.map(r => r.ordinal)).toEqual([1, 2]);
    expect(result.rows[0].notes).toBe(values[10]);
    expect(result.rows[0].raw).toEqual(values);
  });

  it("keeps JPB empty lists and zero count distinct from a missing row", () => {
    const values = row(0, "JPB"); values[6] = ""; values[7] = ""; values[8] = "00000";
    const result = success(parseDistributionTable({ bytes: csv([values], "JPB"), packageType: "JPB" }));
    expect(result.rows[0]).toMatchObject({ skippedNumbers: [], recoveredNumbers: [], dailyCounts: { patents: 0 } });
    expect(result.selectionStatus).toBe("rows_present");
    expect(result.coverageProven).toBe(false);
  });

  it("accepts annual issue reuse in a new year and keeps source order with inversion warnings", () => {
    const previous = row(), next = row(1); previous[0] = "20911231"; next[0] = "20920101"; next[1] = "001";
    const result = success(parseDistributionTable({ bytes: csv([next, previous]), packageType: "JPA" }));
    expect(result.rows.map(r => r.publicationDate)).toEqual(["2092-01-01", "2091-12-31"]);
    expect(result.warnings).toEqual([{ code: "dates_out_of_order", row: 2, column: 1 }]);
  });

  it("selects inclusively using publication dates while retaining unavailable rows and source warnings", () => {
    const a = row(0, "JPB"), b = row(1, "JPB"), c = row(2, "JPB");
    b[9] = "不可"; c[6] = "9000103;9000103";
    const result = success(parseDistributionTable({ bytes: csv([a,b,c], "JPB"), packageType: "JPB", from: "2092-01-01", to: "2092-01-02" }));
    expect(result.rows.map(r => r.ordinal)).toEqual([1, 2]);
    expect(result.counts).toEqual({ selected: 2, available: 1, unavailable: 1, warningRows: 0 });
    expect(result.warnings).toContainEqual({ code: "duplicate_number", row: 3, column: 7 });
    expect(result.observedDateRange).toEqual({ from: "2092-01-01", to: "2092-01-03" });
    expect(result.selectionMode).toBe("date_range");
    expect(result.coverageProven).toBe(false);
  });

  it("does not turn an empty selection into successful coverage", () => {
    const result = success(parseDistributionTable({ bytes: csv([row()]), packageType: "JPA", from: "2093-01-01", to: "2093-01-01" }));
    expect(result).toMatchObject({ selectionStatus: "no_rows_in_snapshot", rows: [], coverageProven: false,
      acquisitionState: "unknown", importState: "unknown", counts: { selected: 0 },
      warnings: [{ code: "requested_range_exceeds_observed_dates" }] });
  });

  it.each([undefined, { from: "2092-01-01", to: "2092-01-02" }])("handles header-only without inventing dates: %j", range => {
    const result = success(parseDistributionTable({ bytes: csv([]), packageType: "JPA", ...range }));
    expect(result).toMatchObject({ sourceRowCount: 0, observedDateRange: null, rows: [],
      selectionStatus: "no_rows_in_snapshot", selectionMode: range ? "date_range" : "all_observed_rows",
      warnings: [{ code: "no_observed_dates" }], coverageProven: false, acquisitionState: "unknown", importState: "unknown" });
    failure(new Uint8Array(), "missing_header");
  });

  it.each([
    { from: "2092-01-01" }, { to: "2092-01-01" }, { from: "2092-01-02", to: "2092-01-01" },
    { from: "2091-02-29", to: "2091-03-01" }, { from: "0000-01-01", to: "0000-01-02" },
    { from: "20920101", to: "2092-01-01" },
  ])("rejects invalid requested ranges %j", range => {
    expect(parseDistributionTable({ bytes: csv([]), packageType: "JPA", ...range }))
      .toEqual({ ok: false, error: { code: "invalid_requested_range" } });
  });

  it.each(["20910229", "21000229", "20921301", "20920100", "00000101", "2092011", " 20920101"])("rejects invalid calendar date %s", value => {
    const values = row(); values[0] = value; failure(csv([values]), "invalid_date");
  });
  it.each(["20000229", "20920229"])("accepts real leap dates %s", value => {
    const values = row(); values[0] = value; success(parseDistributionTable({ bytes: csv([values]), packageType: "JPA" }));
  });

  it.each([[1,"01"], [2,"1"], [3,"１２３４５６"], [4," 001108"], [7,"000-1"], [8,""]])("rejects malformed numeric field %j", (index,value) => {
    const values = row(); values[Number(index)] = String(value); failure(csv([values]), "invalid_digits");
  });
  it.each(["", "unknown", "可 "])("rejects unknown availability %j", value => {
    const values = row(); values[9] = value; failure(csv([values]), "invalid_availability");
  });
  it.each(["20911231～20911230", "20911229～20911230～20911231"])("rejects reversed/multi registration range %s", value => {
    const values = row(0, "JPB"); values[5] = value; failure(csv([values], "JPB"), "invalid_registration_range", "JPB");
  });
  it.each(["9000103;", "9000103,9000105", "900010", " 9000103"])("rejects malformed skipped lists %j", value => {
    const values = row(0, "JPB"); values[6] = value; failure(csv([values], "JPB"), "invalid_number_list", "JPB");
  });
  it.each([0,1,2])("rejects ambiguous duplicate key column %i even outside selected dates", index => {
    const first = row(), second = row(1); second[index] = first[index];
    expect(parseDistributionTable({ bytes: csv([first,second]), packageType: "JPA", from: "2093-01-01", to: "2093-01-02" }))
      .toEqual({ ok: false, error: { code: "duplicate_key", row: 2, column: index + 1 } });
  });
});

describe("bounded parsing and error privacy", () => {
  it("does not repair header order, duplicates, unknown names, or extra/missing fields", () => {
    const base = new TextDecoder().decode(csv([row()]));
    failure(new TextEncoder().encode(base.replace("公報発行日", "unknown")), "invalid_header");
    failure(new TextEncoder().encode(base.replace("年通号", "総通号")), "invalid_header");
    failure(new TextEncoder().encode(base.replace('"公報発行日","年通号"', '"年通号","公報発行日"')), "invalid_header");
    failure(csv([row().slice(0,10)]), "column_count_mismatch");
    failure(csv([[...row(), "extra"]]), "column_count_mismatch");
    failure(new TextEncoder().encode(base + "\n"), "column_count_mismatch");
  });
  it("accepts unquoted CSV fields and preserves decoded quotes rather than splitting on commas", () => {
    const bytes = new TextEncoder().encode([DISTRIBUTION_HEADERS.JPA.join(","), row().join(",")].join("\n"));
    success(parseDistributionTable({ bytes, packageType: "JPA" }));
  });
  it("rejects a bare CR outside quotes while retaining the same character inside notes", () => {
    const text = [DISTRIBUTION_HEADERS.JPA.join(","), row().join(",")].join("\n");
    expect(failure(new TextEncoder().encode(text + "\r"), "invalid_csv"))
      .toEqual({ ok: false, error: { code: "invalid_csv", row: 1, column: 11 } });
    const values = row(); values[10] = "note\rcontinued";
    expect(success(parseDistributionTable({ bytes: csv([values]), packageType: "JPA" })).rows[0].notes).toBe(values[10]);
  });
  it("rejects invalid UTF-8, package type, doubled BOM and malformed quoted input safely", () => {
    failure(new Uint8Array([0xc3,0x28]), "invalid_utf8");
    expect(parseDistributionTable({ bytes: csv([]), packageType: "OTHER" as DistributionPackageType }))
      .toEqual({ ok: false, error: { code: "invalid_package_type" } });
    const doubleBom = new Uint8Array([0xef,0xbb,0xbf, ...csv([])]);
    failure(doubleBom, "invalid_csv");
    const marker = "fictional_private_field_never_report";
    const log = vi.spyOn(console,"log"), error = vi.spyOn(console,"error");
    try {
      const result = failure(new TextEncoder().encode(new TextDecoder().decode(csv([])) + `"${marker}`), "invalid_csv");
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });
  it("counts field characters as code points and enforces the exact ceiling", () => {
    const values = row(); values[10] = "🐟".repeat(DISTRIBUTION_LIMITS.fieldCharacters);
    success(parseDistributionTable({ bytes: csv([values]), packageType: "JPA" }));
    values[10] += "x";
    expect(failure(csv([values]), "field_limit_exceeded"))
      .toEqual({ ok: false, error: { code: "field_limit_exceeded", row: 1, column: 11 } });
  });
  it("enforces data row limits independently of header and quoted physical lines", () => {
    const rows = Array.from({ length: DISTRIBUTION_LIMITS.rows }, (_,i) => row(i));
    rows[0][10] = "one\ntwo";
    expect(success(parseDistributionTable({ bytes: csv(rows), packageType: "JPA" })).sourceRowCount).toBe(10000);
    rows.push(row(10000));
    expect(failure(csv(rows), "row_limit_exceeded")).toEqual({ ok: false, error: { code: "row_limit_exceeded", row: 10001 } });
  });
  it("accepts exactly one MiB and rejects one byte more before parsing", () => {
    const rows = Array.from({ length: 80 }, (_,i) => row(i));
    let remaining = DISTRIBUTION_LIMITS.bytes - csv(rows).byteLength;
    for (const values of rows) {
      const add = Math.min(remaining, DISTRIBUTION_LIMITS.fieldCharacters);
      values[10] = "x".repeat(add); remaining -= add;
    }
    expect(remaining).toBe(0);
    const bytes = csv(rows); expect(bytes.byteLength).toBe(DISTRIBUTION_LIMITS.bytes);
    success(parseDistributionTable({ bytes, packageType: "JPA" }));
    failure(new Uint8Array([...bytes, 10]), "byte_limit_exceeded");
  });
});
