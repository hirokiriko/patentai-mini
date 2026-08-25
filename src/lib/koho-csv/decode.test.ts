import { describe, expect, it } from "vitest";

import { decodeKohoCsv, inspectLineEndings } from "./decode";

const encoder = new TextEncoder();

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function withUtf8Bom(value: string): Uint8Array {
  const payload = utf8(value);
  const result = new Uint8Array(3 + payload.byteLength);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(payload, 3);
  return result;
}

describe("decodeKohoCsv", () => {
  it("BOMなしUTF-8とCRLF metadataを返す", () => {
    const source = "a,b\r\nc,d\r\n";
    expect(decodeKohoCsv(utf8(source))).toEqual({
      ok: true,
      encoding: {
        name: "utf-8",
        fatalDecode: true,
        bom: "none",
        byteLength: utf8(source).byteLength,
      },
      text: source,
      lineEndings: {
        style: "crlf",
        crlfCount: 2,
        lfCount: 0,
        crCount: 0,
        hasTerminalCrlf: true,
      },
      issues: [],
    });
  });

  it("UTF-8 BOMをmetadataへ保持してparse textからだけ除く", () => {
    const result = decodeKohoCsv(withUtf8Bom("a,b\r\n"));

    expect(result).toMatchObject({
      ok: true,
      encoding: { bom: "utf8" },
      text: "a,b\r\n",
      issues: [
        expect.objectContaining({
          code: "utf8_bom_present",
          status: "review_required",
        }),
      ],
    });
  });

  it("先頭以外のU+FEFFはsource textとして保持する", () => {
    const result = decodeKohoCsv(utf8("a,\uFEFFb\r\n"));
    expect(result).toMatchObject({ ok: true, text: "a,\uFEFFb\r\n" });
  });

  it("先頭BOMだけを除去し、直後のU+FEFFはsourceとして保持する", () => {
    const secondBomAndRecord = withUtf8Bom("\uFEFFa,b\r\n");
    const result = decodeKohoCsv(secondBomAndRecord);

    expect(result).toMatchObject({
      ok: true,
      encoding: { bom: "utf8" },
      text: "\uFEFFa,b\r\n",
    });
  });

  it("invalid UTF-8を例外でなく判別unionとして返す", () => {
    const result = decodeKohoCsv(new Uint8Array([0xc3, 0x28]));

    expect(result).toEqual({
      ok: false,
      encoding: {
        name: "utf-8",
        fatalDecode: true,
        bom: "none",
        byteLength: 2,
      },
      lineEndings: null,
      issues: [
        expect.objectContaining({ code: "invalid_utf8", status: "failed" }),
      ],
    });
    expect("text" in result).toBe(false);
  });

  it("BOM後のinvalid UTF-8ではBOMとfatal errorの両issueを保持する", () => {
    const result = decodeKohoCsv(
      new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0x28]),
    );
    expect(result.ok).toBe(false);
    expect(result.encoding.bom).toBe("utf8");
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "utf8_bom_present",
      "invalid_utf8",
    ]);
  });

  it("UTF-16 BOMをUTF-8として推測変換しない", () => {
    const result = decodeKohoCsv(new Uint8Array([0xff, 0xfe, 0x61, 0x00]));
    expect(result).toMatchObject({
      ok: false,
      encoding: { bom: "none" },
      issues: [expect.objectContaining({ code: "invalid_utf8" })],
    });
  });

  it("0 byteはempty_fileとしmissing terminalを重ねない", () => {
    const result = decodeKohoCsv(new Uint8Array());
    expect(result).toMatchObject({
      ok: true,
      text: "",
      lineEndings: { style: "none", hasTerminalCrlf: false },
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(["empty_file"]);
  });

  it("BOM-onlyはBOM reviewとempty_file failureを保持する", () => {
    const result = decodeKohoCsv(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(result).toMatchObject({ ok: true, text: "" });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "utf8_bom_present",
      "empty_file",
    ]);
  });

  it("LF、CR、mixedをcountし未観察newlineをreview_requiredにする", () => {
    const source = "a\r\nb\nc\rd\r\n";
    const result = decodeKohoCsv(utf8(source));

    expect(result).toMatchObject({
      ok: true,
      lineEndings: {
        style: "mixed",
        crlfCount: 2,
        lfCount: 1,
        crCount: 1,
        hasTerminalCrlf: true,
      },
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unobserved_line_ending",
    ]);
  });

  it("quoted field内を含めCRLFだけなら観察済みnewlineとして数える", () => {
    const source = '"a\r\nb",c\r\n';
    const result = decodeKohoCsv(utf8(source));

    expect(result).toMatchObject({
      ok: true,
      lineEndings: {
        style: "crlf",
        crlfCount: 2,
        lfCount: 0,
        crCount: 0,
        hasTerminalCrlf: true,
      },
      issues: [],
    });
  });

  it("parse可能な終端CRLFなしsourceをreview_requiredにする", () => {
    const result = decodeKohoCsv(utf8("a,b"));
    expect(result).toMatchObject({
      ok: true,
      lineEndings: { style: "none", hasTerminalCrlf: false },
      issues: [
        expect.objectContaining({ code: "missing_terminal_crlf" }),
      ],
    });
  });

  it("固定error messageへsource内容を転載しない", () => {
    const sourceMarker = "FICTIONAL-SENSITIVE-MARKER";
    const invalid = new Uint8Array([
      ...utf8(sourceMarker),
      0xc3,
      0x28,
    ]);
    const result = decodeKohoCsv(invalid);

    expect(result.ok).toBe(false);
    expect(result.issues.every((issue) => !issue.message.includes(sourceMarker))).toBe(
      true,
    );
  });
});

describe("inspectLineEndings", () => {
  it.each([
    ["a\r\n", "crlf", 1, 0, 0, true],
    ["a\n", "lf", 0, 1, 0, false],
    ["a\r", "cr", 0, 0, 1, false],
    ["a", "none", 0, 0, 0, false],
  ] as const)(
    "%jを%sとして分類する",
    (source, style, crlfCount, lfCount, crCount, hasTerminalCrlf) => {
      expect(inspectLineEndings(source)).toEqual({
        style,
        crlfCount,
        lfCount,
        crCount,
        hasTerminalCrlf,
      });
    },
  );
});
