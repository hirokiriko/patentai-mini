import { describe, expect, it } from "vitest";

import { inspectKohoCsvPath } from "./path";
import type { KohoCsvLogicalFile, KohoCsvPackageType } from "./types";

describe("inspectKohoCsvPath", () => {
  it.each<
    [KohoCsvPackageType, string, KohoCsvLogicalFile]
  >([
    ["JPA", "ABSTRACT.csv", "ABSTRACT"],
    ["JPB", "ABSTRACT.csv", "ABSTRACT"],
    ["JPA", "DOCUMENT_LIST.csv", "DOCUMENT_LIST"],
    ["JPB", "DOCUMENT_LIST.csv", "DOCUMENT_LIST"],
    ["JPA", "DOCUMENT/P_A1/CONTENTS1.csv", "CONTENTS1"],
    ["JPA", "DOCUMENT/P_A1/CONTENTS2.csv", "CONTENTS2"],
    ["JPA", "DOCUMENT/P_P1/CONTENTS1.csv", "CONTENTS1"],
    ["JPA", "DOCUMENT/P_P1/CONTENTS2.csv", "CONTENTS2"],
    ["JPB", "DOCUMENT/P_B1/CONTENTS1.csv", "CONTENTS1"],
    ["JPB", "DOCUMENT/P_B1/CONTENTS2.csv", "CONTENTS2"],
  ])("%s %sを%sとして識別する", (packageType, path, logicalFile) => {
    expect(inspectKohoCsvPath(packageType, path)).toEqual({
      status: "success",
      sourceEntryPath: path,
      normalizedEntryPath: path,
      logicalFile,
      issues: [],
    });
  });

  it("安全なbackslashをslashへ正規化してから照合する", () => {
    const sourceEntryPath = "DOCUMENT\\P_A1\\CONTENTS1.csv";
    expect(inspectKohoCsvPath("JPA", sourceEntryPath)).toMatchObject({
      status: "success",
      sourceEntryPath,
      normalizedEntryPath: "DOCUMENT/P_A1/CONTENTS1.csv",
      logicalFile: "CONTENTS1",
    });
  });

  it.each([
    ["empty", ""],
    ["NUL", "DOCUMENT/P_A1/CONTENTS1\0.csv"],
    ["forward UNC", "//server/share/ABSTRACT.csv"],
    ["backslash UNC", "\\\\server\\share\\ABSTRACT.csv"],
    ["drive", "C:\\DOCUMENT\\P_A1\\CONTENTS1.csv"],
    ["absolute slash", "/ABSTRACT.csv"],
    ["absolute backslash", "\\ABSTRACT.csv"],
    ["trailing slash", "DOCUMENT/P_A1/CONTENTS1.csv/"],
    ["trailing backslash", "DOCUMENT\\P_A1\\CONTENTS1.csv\\"],
    ["empty segment", "DOCUMENT//P_A1/CONTENTS1.csv"],
    ["dot segment", "DOCUMENT/./P_A1/CONTENTS1.csv"],
    ["parent segment", "DOCUMENT/P_A1/../CONTENTS1.csv"],
  ])("%s pathをdecode前にfailedへする", (_label, sourceEntryPath) => {
    const result = inspectKohoCsvPath("JPA", sourceEntryPath);

    expect(result).toMatchObject({
      status: "failed",
      sourceEntryPath,
      normalizedEntryPath: null,
      logicalFile: null,
      issues: [
        expect.objectContaining({
          code: "unsafe_entry_path",
          status: "failed",
        }),
      ],
    });
    if (result.status !== "failed") {
      throw new Error("expected an unsafe path failure");
    }
    const issue = result.issues[0];
    expect(issue.message).toBe("CSV entry path is unsafe");
    if (sourceEntryPath.length > 0) {
      expect(issue.message).not.toContain(sourceEntryPath);
    }
  });

  it.each([
    ["OTHER.csv", "unsupported_logical_file"],
    ["abstract.csv", "unsupported_logical_file"],
    ["folder/ABSTRACT.csv", "unsupported_entry_placement"],
    ["folder/DOCUMENT_LIST.csv", "unsupported_entry_placement"],
    ["DOCUMENT_LIST.csv/extra", "unsupported_logical_file"],
    ["CONTENTS1.csv", "unsupported_entry_placement"],
    ["DOCUMENT/P_A5/CONTENTS1.csv", "unsupported_entry_placement"],
    ["DOCUMENT/P_P5/CONTENTS2.csv", "unsupported_entry_placement"],
    ["DOCUMENT/P_UNKNOWN/CONTENTS1.csv", "unsupported_entry_placement"],
    ["DOCUMENT/P_A1/extra/CONTENTS1.csv", "unsupported_entry_placement"],
  ])("安全な対象外path %sをunsupported_typeへする", (path, code) => {
    expect(inspectKohoCsvPath("JPA", path)).toMatchObject({
      status: "unsupported_type",
      normalizedEntryPath: path,
      logicalFile: null,
      issues: [expect.objectContaining({ code, status: "unsupported_type" })],
    });
  });

  it.each<
    [KohoCsvPackageType, string, KohoCsvLogicalFile]
  >([
    ["JPA", "DOCUMENT/P_B1/CONTENTS1.csv", "CONTENTS1"],
    ["JPA", "DOCUMENT/P_B1/CONTENTS2.csv", "CONTENTS2"],
    ["JPB", "DOCUMENT/P_A1/CONTENTS1.csv", "CONTENTS1"],
    ["JPB", "DOCUMENT/P_A1/CONTENTS2.csv", "CONTENTS2"],
    ["JPB", "DOCUMENT/P_P1/CONTENTS1.csv", "CONTENTS1"],
    ["JPB", "DOCUMENT/P_P1/CONTENTS2.csv", "CONTENTS2"],
  ])("%sと%sのsection矛盾をfailedへする", (packageType, path, logicalFile) => {
    expect(inspectKohoCsvPath(packageType, path)).toMatchObject({
      status: "failed",
      normalizedEntryPath: path,
      logicalFile,
      issues: [
        expect.objectContaining({
          code: "package_section_mismatch",
          status: "failed",
        }),
      ],
    });
  });

  it.each(["toString", "constructor", "__proto__"])(
    "prototype由来basename %sを未知logical fileとして扱う",
    (basename) => {
      const result = inspectKohoCsvPath(
        "JPA",
        `DOCUMENT/P_A1/${basename}`,
      );

      expect(result).toMatchObject({
        status: "unsupported_type",
        logicalFile: null,
        issues: [
          expect.objectContaining({ code: "unsupported_logical_file" }),
        ],
      });
    },
  );
});
