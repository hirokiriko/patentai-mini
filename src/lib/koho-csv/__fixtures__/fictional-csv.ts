import type { KohoCsvLimits, KohoCsvPackageType } from "../types";

export const FICTIONAL_LIMITS: KohoCsvLimits = {
  maxCsvBytes: 100_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 50_000,
  maxRepeatedItemsPerRecord: 20,
};

export function fictionalCsvBytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

export function fictionalAbstractCsv(
  packageType: KohoCsvPackageType,
): string {
  const summary =
    packageType === "JPA"
      ? "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001"
      : "特許公報,FICTIONAL-RANGE-0001,00002,FICTIONAL-MISSING-0001,FICTIONAL-OUTSIDE-0001";
  return (
    `${packageType},20990228,FICTIONAL-ISSUE-0001,01122\r\n` +
    `${summary}\r\n`
  );
}

export function fictionalDocumentListCsv(
  packageType: KohoCsvPackageType,
): string {
  const kind = packageType === "JPA" ? "A" : "B1";
  return `JP,0000-FICTIONAL-PUBLICATION-0001,${kind},20990228\r\n`;
}
