import { parse } from "csv-parse/sync";

export interface JPlatPatRow {
  publicationNo: string;
  applicationNo: string | null;
  applicationDate: string | null;
  publicDate: string | null;
  title: string;
  applicant: string | null;
  fi: string | null;
  abstract: string | null;
  publicationUrl: string | null;
  rawRow: Record<string, string>;
}

/**
 * J-PlatPat からダウンロードした CSV をパースする。
 * 要約列はオプショナル（ユーザーが CSV に含めるか選択可能）。
 * BOM 付き UTF-8、改行を含むフィールドに対応。
 */
export function parseJPlatPatCsv(csvText: string): JPlatPatRow[] {
  // BOM 除去
  const text = csvText.replace(/^\uFEFF/, "");

  const records: Record<string, string>[] = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return records
    .filter((r) => r["文献番号"])
    .map((r) => ({
      publicationNo: r["文献番号"],
      applicationNo: r["出願番号"] || null,
      applicationDate: r["出願日"] || null,
      publicDate: r["公知日"] || null,
      title: r["発明の名称"] ?? "",
      applicant: r["出願人/権利者"] || null,
      fi: r["FI"] || null,
      abstract: r["要約"] || null,
      publicationUrl: r["文献URL"] || null,
      rawRow: r,
    }));
}
