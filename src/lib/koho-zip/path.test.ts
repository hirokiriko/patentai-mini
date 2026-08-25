import { describe, expect, it } from "vitest";

import { KohoZipError } from "./errors";
import { inspectEntryPath } from "./path";

describe("inspectEntryPath", () => {
  it.each([
    "",
    "../FICTIONAL.xml",
    "safe/../FICTIONAL.xml",
    "/FICTIONAL.xml",
    "C:/FICTIONAL.xml",
    "//server/share/FICTIONAL.xml",
    "safe/\0FICTIONAL.xml",
    "safe/./FICTIONAL.xml",
    "safe//FICTIONAL.xml",
  ])("rejects unsafe or ambiguous path %j", (path) => {
    expect(() => inspectEntryPath(path)).toThrowError(
      expect.objectContaining<Partial<KohoZipError>>({
        code: "unsafe_entry_path",
      }),
    );
  });

  it("normalizes backslashes without losing the directory distinction", () => {
    expect(inspectEntryPath("FICTIONAL\\nested\\")).toEqual({
      normalizedPath: "FICTIONAL/nested",
      isDirectory: true,
      role: "directory",
      pathCandidate: "none",
    });
  });

  it.each([
    ["INDEX/FICTIONAL.csv", "csv"],
    ["XSD/FICTIONAL.xsd", "schema"],
    ["SCHEMA/FICTIONAL.dtd", "schema"],
    ["IMAGE/FICTIONAL.tif", "image"],
    ["DOCUMENT/FICTIONAL.xml", "xml"],
    ["OTHER/FICTIONAL.bin", "other"],
  ] as const)("classifies %s as %s", (path, role) => {
    expect(inspectEntryPath(path).role).toBe(role);
  });

  it("only marks the exact public path shape as a primary XML candidate", () => {
    const primary =
      "DOCUMENT/P_A1/FICTIONAL-100/FICTIONAL-10/FICTIONAL-DOC/FICTIONAL-DOC.xml";
    expect(inspectEntryPath(primary).pathCandidate).toBe("primary_xml");
    expect(
      inspectEntryPath(
        "DOCUMENT/P_A1/FICTIONAL-100/FICTIONAL-10/FICTIONAL-DOC/SEQL/FICTIONAL.xml",
      ).pathCandidate,
    ).toBe("nested_xml");
    expect(
      inspectEntryPath(
        "DOCUMENT/P_UNKNOWN/FICTIONAL-100/FICTIONAL-10/FICTIONAL-DOC/FICTIONAL-DOC.xml",
      ).pathCandidate,
    ).toBe("none");
  });
});
