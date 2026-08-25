import { describe, expect, it } from "vitest";

import { parseKohoCsv } from "./index";
import {
  FICTIONAL_LIMITS,
  fictionalCsvBytes,
} from "./__fixtures__/fictional-csv";

describe("Koho CSV information safety", () => {
  it("parser error messageへcell、entry path、local path風markerを転載しない", () => {
    const markers = [
      "FICTIONAL-SECRET-CELL-7b09",
      "FICTIONAL-ENTRY-PATH-7b09",
      "C:\\FICTIONAL\\LOCAL-PATH-7b09",
    ];
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: `DOCUMENT_LIST.csv`,
      bytes: fictionalCsvBytes(
        `JP,"${markers[0]}-${markers[1]}-${markers[2]},A,20990228\r\n`,
      ),
      limits: FICTIONAL_LIMITS,
    });
    const messages = result.issues.map((issue) => issue.message).join("\n");

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "csv_syntax_error",
    );
    for (const marker of markers) expect(messages).not.toContain(marker);
  });

  it("validation issue messageを入力値に依存させない", () => {
    const markers = [
      "FICTIONAL-SECRET-COUNTRY-b643",
      "FICTIONAL-SECRET-KIND-b643",
      "FICTIONAL-SECRET-DATE-b643",
    ];
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: fictionalCsvBytes(
        `${markers[0]},FICTIONAL-PUBLICATION,${markers[1]},${markers[2]}\r\n`,
      ),
      limits: FICTIONAL_LIMITS,
    });
    const allIssues = [
      ...result.issues,
      ...result.records.flatMap((record) => record.issues),
    ];

    expect(result.status).toBe("failed");
    expect(allIssues.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(allIssues.every((issue) => !issue.message.includes(marker))).toBe(
        true,
      );
    }
  });

  it("unsafe entry pathを固定messageへ転載しない", () => {
    const marker = "C:\\FICTIONAL-LOCAL-PATH-ENTRY-43a1\\ABSTRACT.csv";
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: marker,
      bytes: Uint8Array.from([0xff]),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unsafe_entry_path",
    ]);
    expect(result.issues[0].message).not.toContain(marker);
  });
});
