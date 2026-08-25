import { describe, expect, it } from "vitest";

import {
  addToCodePointTotal,
  checkCsvByteLimit,
  countUnicodeCodePoints,
  validateLimits,
  wouldExceedSafeLimit,
} from "./limits";
import type { KohoCsvLimits } from "./types";

const VALID_LIMITS: KohoCsvLimits = {
  maxCsvBytes: 100,
  maxRecords: 10,
  maxColumnsPerRecord: 20,
  maxCellCharacters: 50,
  maxTotalCharacters: 200,
  maxRepeatedItemsPerRecord: 5,
};

describe("validateLimits", () => {
  it("positive finite safe integerだけを受け入れる", () => {
    expect(validateLimits(VALID_LIMITS)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 53])(
    "契約外limit %sを拒否する",
    (invalidValue) => {
      const limits = { ...VALID_LIMITS, maxRecords: invalidValue };

      expect(validateLimits(limits)).toEqual([
        expect.objectContaining({
          code: "invalid_limits",
          status: "failed",
          field: "maxRecords",
        }),
      ]);
    },
  );

  it("複数の不正fieldをfield別にすべて返す", () => {
    const issues = validateLimits({
      ...VALID_LIMITS,
      maxCsvBytes: 0,
      maxCellCharacters: Number.NaN,
    });

    expect(issues.map((issue) => [issue.code, issue.field])).toEqual([
      ["invalid_limits", "maxCsvBytes"],
      ["invalid_limits", "maxCellCharacters"],
    ]);
  });

  it("runtimeでobject以外が渡されても例外を投げない", () => {
    expect(validateLimits(null as unknown as KohoCsvLimits)).toEqual([
      expect.objectContaining({ code: "invalid_limits", field: "limits" }),
    ]);
  });
});

describe("checkCsvByteLimit", () => {
  it("上限と同じbyte lengthを許可する", () => {
    const bytes = new Uint8Array(VALID_LIMITS.maxCsvBytes);
    expect(checkCsvByteLimit(bytes, VALID_LIMITS)).toEqual([]);
  });

  it("上限を1 byte超えた時だけstable issueを返す", () => {
    const bytes = new Uint8Array(VALID_LIMITS.maxCsvBytes + 1);
    expect(checkCsvByteLimit(bytes, VALID_LIMITS)).toEqual([
      expect.objectContaining({
        code: "csv_byte_limit_exceeded",
        status: "failed",
        field: "maxCsvBytes",
      }),
    ]);
  });

  it("単独利用でも不正maxCsvBytesを無制限扱いしない", () => {
    const limits = { ...VALID_LIMITS, maxCsvBytes: 0 };
    expect(checkCsvByteLimit(new Uint8Array(), limits)).toEqual([
      expect.objectContaining({ code: "invalid_limits" }),
    ]);
  });
});

describe("Unicode code point accounting", () => {
  it("supplementary characterを1、combining markを別code pointとして数える", () => {
    expect(countUnicodeCodePoints("A😀e\u0301")).toBe(4);
  });

  it("limitとの差を使ってoverflow-safeに判定する", () => {
    expect(wouldExceedSafeLimit(7, 3, 10)).toBe(false);
    expect(wouldExceedSafeLimit(7, 4, 10)).toBe(true);
    expect(
      wouldExceedSafeLimit(
        Number.MAX_SAFE_INTEGER,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(true);
  });

  it("不正なaccounting stateを安全側で超過扱いする", () => {
    expect(wouldExceedSafeLimit(-1, 1, 10)).toBe(true);
    expect(wouldExceedSafeLimit(0, Number.NaN, 10)).toBe(true);
    expect(wouldExceedSafeLimit(0, 0, 0)).toBe(true);
  });

  it("加算可能時だけcode point totalを更新する", () => {
    expect(addToCodePointTotal(2, "😀a", 4)).toEqual({
      ok: true,
      total: 4,
      addition: 2,
    });
    expect(addToCodePointTotal(3, "😀a", 4)).toEqual({
      ok: false,
      total: 3,
      addition: 2,
    });
  });
});
