import { describe, expect, it } from "vitest";

import {
  inspectKohoEntryPath,
  isExpectedXsdPath,
  normalizeZipEntryPath,
  resolveSchemaLocationToken,
  type KohoSection,
} from "./path";

function expectValidEntry(sourcePath: string) {
  const result = inspectKohoEntryPath(sourcePath);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected a valid entry path: ${result.error.code}`);
  }
  return result;
}

describe("normalizeZipEntryPath", () => {
  it("source pathを保持し、backslashをforward slashへ正規化する", () => {
    const sourcePath =
      "DOCUMENT\\P_A1\\000100\\000120\\2099000123\\2099000123.xml";
    const result = normalizeZipEntryPath(sourcePath);

    expect(result).toEqual({
      ok: true,
      sourcePath,
      normalizedPath:
        "DOCUMENT/P_A1/000100/000120/2099000123/2099000123.xml",
      segments: [
        "DOCUMENT",
        "P_A1",
        "000100",
        "000120",
        "2099000123",
        "2099000123.xml",
      ],
    });
  });

  it.each([
    ["empty", "", "EMPTY_PATH"],
    ["absolute", "/DOCUMENT/P_A1/file.xml", "ABSOLUTE_PATH"],
    ["drive", "C:\\DOCUMENT\\P_A1\\file.xml", "DRIVE_PATH"],
    ["UNC", "\\\\server\\share\\file.xml", "UNC_PATH"],
    ["NUL", "DOCUMENT/P_A1/file\0.xml", "NUL_BYTE"],
    ["dot", "DOCUMENT/./P_A1/file.xml", "DOT_SEGMENT"],
    ["parent", "DOCUMENT/P_A1/../file.xml", "PARENT_SEGMENT"],
    ["empty segment", "DOCUMENT//P_A1/file.xml", "EMPTY_SEGMENT"],
    ["trailing slash", "DOCUMENT/P_A1/", "TRAILING_SLASH"],
  ])("%s pathを拒否する", (_label, sourcePath, expectedCode) => {
    const result = normalizeZipEntryPath(sourcePath);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected an invalid entry path");
    }
    expect(result.sourcePath).toBe(sourcePath);
    expect(result.error.code).toBe(expectedCode);
  });
});

describe("inspectKohoEntryPath", () => {
  it.each<KohoSection>(["P_A1", "P_A5", "P_P1", "P_P5", "P_B1"])(
    "%sのprimary XML形状を識別する",
    (section) => {
      const result = expectValidEntry(
        `DOCUMENT/${section}/000100/000120/2099000123/2099000123.xml`,
      );

      expect(result).toMatchObject({
        section,
        bucket100: "000100",
        bucket10: "000120",
        documentNumber: "2099000123",
        basename: "2099000123.xml",
        documentRelativeSegments: ["2099000123.xml"],
        isXml: true,
        isPrimaryXml: true,
        isDeeperXml: false,
        pathKind: "primary-xml",
      });
    },
  );

  it("document folderとbasenameが違うXMLをprimaryにしない", () => {
    const result = expectValidEntry(
      "DOCUMENT/P_A1/000100/000120/2099000123/2099000999.xml",
    );

    expect(result).toMatchObject({
      section: "P_A1",
      documentNumber: "2099000123",
      basename: "2099000999.xml",
      isXml: true,
      isPrimaryXml: false,
      isDeeperXml: false,
      pathKind: "other",
    });
  });

  it("document配下のより深いXMLをprimaryと分けて返す", () => {
    const result = expectValidEntry(
      "DOCUMENT/P_P1/000200/000230/WO2099000123/AMEN00001/amendment.xml",
    );

    expect(result).toMatchObject({
      section: "P_P1",
      documentNumber: "WO2099000123",
      basename: "amendment.xml",
      documentRelativeSegments: ["AMEN00001", "amendment.xml"],
      isXml: true,
      isPrimaryXml: false,
      isDeeperXml: true,
      pathKind: "deeper-xml",
    });
  });

  it("未知sectionをprimaryまたはdeeper XMLにしない", () => {
    const result = expectValidEntry(
      "DOCUMENT/P_UNKNOWN/000100/000120/2099000123/2099000123.xml",
    );

    expect(result).toMatchObject({
      section: null,
      documentNumber: null,
      isXml: true,
      isPrimaryXml: false,
      isDeeperXml: false,
      pathKind: "other",
    });
  });
});

describe("resolveSchemaLocationToken", () => {
  const entryPath =
    "DOCUMENT\\P_A1\\000100\\000120\\2099000123\\2099000123.xml";
  const expectedXsdBasename = "JPUnexaminedPatentPublication_V1_0.xsd";

  it("entry directory基準で相対tokenをZIP rootのXSDへ解決する", () => {
    const locationToken = `../../../../../XSD/${expectedXsdBasename}`;
    const result = resolveSchemaLocationToken(
      entryPath,
      locationToken,
      expectedXsdBasename,
    );

    expect(result).toEqual({
      ok: true,
      entryPath,
      normalizedEntryPath:
        "DOCUMENT/P_A1/000100/000120/2099000123/2099000123.xml",
      locationToken,
      expectedXsdBasename,
      resolvedPath: `XSD/${expectedXsdBasename}`,
      resolvedBasename: expectedXsdBasename,
      isXsdRootFile: true,
      matchesExpectedXsdPath: true,
    });
  });

  it("安全に解決できても期待XSD basenameと違えばfalseを返す", () => {
    const result = resolveSchemaLocationToken(
      entryPath,
      "../../../../../XSD/JPAnotherPublication_V1_0.xsd",
      expectedXsdBasename,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected a resolved schema path: ${result.error.code}`);
    }
    expect(result.resolvedPath).toBe(
      "XSD/JPAnotherPublication_V1_0.xsd",
    );
    expect(result.isXsdRootFile).toBe(true);
    expect(result.matchesExpectedXsdPath).toBe(false);
  });

  it("XSDの下位directoryへ解決したpathを期待pathにしない", () => {
    const result = resolveSchemaLocationToken(
      entryPath,
      `../../../../../XSD/nested/${expectedXsdBasename}`,
      expectedXsdBasename,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected a resolved schema path: ${result.error.code}`);
    }
    expect(result.isXsdRootFile).toBe(false);
    expect(result.matchesExpectedXsdPath).toBe(false);
  });

  it("package rootを越えるparent segmentを拒否する", () => {
    const result = resolveSchemaLocationToken(
      entryPath,
      `../../../../../../XSD/${expectedXsdBasename}`,
      expectedXsdBasename,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a package escape failure");
    }
    expect(result.error.code).toBe("PACKAGE_ESCAPE");
  });

  it.each([
    ["absolute URI", `https://example.test/${expectedXsdBasename}`],
    ["opaque URI", `file:${expectedXsdBasename}`],
    ["absolute path", `/XSD/${expectedXsdBasename}`],
    ["drive path", `C:/XSD/${expectedXsdBasename}`],
    ["forward-slash UNC", `//server/XSD/${expectedXsdBasename}`],
    ["backslash UNC", `\\\\server\\XSD\\${expectedXsdBasename}`],
    ["backslash", `../../../../../XSD\\${expectedXsdBasename}`],
    ["NUL", `../../../../../XSD/${expectedXsdBasename}\0`],
    ["empty segment", `../../../../../XSD//${expectedXsdBasename}`],
    ["trailing slash", "../../../../../XSD/"],
  ])("%s location tokenを拒否する", (_label, locationToken) => {
    const result = resolveSchemaLocationToken(
      entryPath,
      locationToken,
      expectedXsdBasename,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected an invalid schema location");
    }
    expect(result.locationToken).toBe(locationToken);
  });

  it("不正な参照元entry pathを拒否し、元errorを保持する", () => {
    const result = resolveSchemaLocationToken(
      "DOCUMENT/P_A1/../document.xml",
      `XSD/${expectedXsdBasename}`,
      expectedXsdBasename,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected an invalid entry path failure");
    }
    expect(result.error.code).toBe("INVALID_ENTRY_PATH");
    expect(result.error.entryPathError?.code).toBe("PARENT_SEGMENT");
  });
});

describe("isExpectedXsdPath", () => {
  it("ZIP root直下の完全一致だけをtrueにする", () => {
    expect(isExpectedXsdPath("XSD/Schema_V1_0.xsd", "Schema_V1_0.xsd")).toBe(
      true,
    );
    expect(
      isExpectedXsdPath(
        "XSD/nested/Schema_V1_0.xsd",
        "Schema_V1_0.xsd",
      ),
    ).toBe(false);
    expect(isExpectedXsdPath("OTHER/Schema_V1_0.xsd", "Schema_V1_0.xsd")).toBe(
      false,
    );
    expect(isExpectedXsdPath("XSD/Schema_V1_0.xsd", "../Schema_V1_0.xsd")).toBe(
      false,
    );
  });
});
