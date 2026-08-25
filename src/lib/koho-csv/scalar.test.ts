import { describe, expect, it } from "vitest";

import {
  countCodePoints,
  optionalString,
  parseCsvDate,
  parseCsvDecimal,
  parseSemicolonList,
  removeTrailingAsciiSpaces,
  validateCharacterLength,
  validateRequiredField,
} from "./scalar";

const context = { recordOrdinal: 2, field: "fictionalField" };

describe("koho CSV scalar validation", () => {
  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(countCodePoints("架空😀値")).toBe(4);
    expect(
      validateCharacterLength(4, "架空😀値", context),
    ).toEqual({ actualLength: 4, issue: null });

    const mismatch = validateCharacterLength(5, "架空😀値", context);
    expect(mismatch.actualLength).toBe(4);
    expect(mismatch.issue).toEqual(
      expect.objectContaining({
        code: "character_length_mismatch",
        status: "failed",
        recordOrdinal: 2,
        field: "fictionalField",
      }),
    );
  });

  it("rejects only an actually empty required field", () => {
    expect(validateRequiredField("架空", context)).toEqual({
      ok: true,
      value: "架空",
    });
    expect(validateRequiredField(" ", context)).toEqual({
      ok: true,
      value: " ",
    });
    expect(validateRequiredField("", context)).toEqual({
      ok: false,
      issue: expect.objectContaining({
        code: "required_field_empty",
        status: "failed",
      }),
    });
  });

  it.each([
    "20000229",
    "20010228",
    "20000229",
    "24000229",
    "00010101",
    "99991231",
  ])("accepts valid Gregorian YYYYMMDD %s", (value) => {
    expect(parseCsvDate(value, context)).toEqual({ ok: true, value });
  });

  it.each([
    "00000101",
    "19000229",
    "20010229",
    "20990230",
    "20991301",
    "20990001",
    "20990100",
    "2099-01-01",
    "２０９９０１０１",
    " 20990101",
  ])("rejects invalid Gregorian YYYYMMDD %s", (value) => {
    expect(parseCsvDate(value, context)).toEqual({
      ok: false,
      issue: expect.objectContaining({ code: "invalid_date", status: "failed" }),
    });
  });

  it("parses decimal values without losing their source representation", () => {
    expect(parseCsvDecimal("00042", context)).toEqual({
      ok: true,
      value: { sourceValue: "00042", value: 42 },
    });
    expect(parseCsvDecimal("00042", context, { exactDigits: 5 })).toEqual({
      ok: true,
      value: { sourceValue: "00042", value: 42 },
    });
  });

  it.each([
    ["", undefined],
    ["-1", undefined],
    ["+1", undefined],
    ["1.0", undefined],
    ["1e2", undefined],
    ["１２", undefined],
    ["0001", 5],
    ["9007199254740992", undefined],
  ] as const)("rejects invalid decimal %s", (value, exactDigits) => {
    expect(
      parseCsvDecimal(
        value,
        context,
        exactDigits === undefined ? {} : { exactDigits },
      ),
    ).toEqual({
      ok: false,
      issue: expect.objectContaining({
        code: "invalid_decimal",
        status: "failed",
      }),
    });
  });

  it("parses semicolon lists without trimming or deduplicating", () => {
    expect(parseSemicolonList("", context)).toEqual({
      ok: true,
      value: { sourceValue: "", values: [] },
    });
    expect(parseSemicolonList("001; 002;001", context)).toEqual({
      ok: true,
      value: {
        sourceValue: "001; 002;001",
        values: ["001", " 002", "001"],
      },
    });
  });

  it.each([";001", "001;", "001;;002"])(
    "rejects empty semicolon item in %s",
    (value) => {
      expect(parseSemicolonList(value, context)).toEqual({
        ok: false,
        issue: expect.objectContaining({
          code: "invalid_semicolon_list",
          status: "failed",
        }),
      });
    },
  );

  it("preserves optional source values and removes only trailing ASCII spaces", () => {
    expect(optionalString("")).toEqual({ sourceValue: "", value: null });
    expect(optionalString(" ")).toEqual({ sourceValue: " ", value: " " });
    expect(optionalString("0001")).toEqual({
      sourceValue: "0001",
      value: "0001",
    });

    expect(removeTrailingAsciiSpaces("架空   ")).toBe("架空");
    expect(removeTrailingAsciiSpaces(" 架空\t　 ")).toBe(" 架空\t　");
  });
});
