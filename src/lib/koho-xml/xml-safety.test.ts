import { describe, expect, it } from "vitest";

import {
  FICTIONAL_KOHO_LIMITS,
  FICTIONAL_NESTED_ST26_ENTRY_PATH,
  FICTIONAL_NESTED_ST26_XML,
  FICTIONAL_ST26_V1_3_DOCTYPE,
  createFictionalKohoInput,
} from "./__fixtures__/fictional-koho";
import { parseKohoXml } from "./index";
import type { KohoXmlParseInput } from "./types";
import { parseXmlTree } from "./xml-tree";

function issueCodes(result: ReturnType<typeof parseKohoXml>): string[] {
  return result.issues.map((item) => item.code);
}

describe("parseKohoXml XML safety", () => {
  it("validates every limit before reading the XML value", () => {
    const input = createFictionalKohoInput("A1");
    let xmlWasRead = false;
    Object.defineProperty(input, "xml", {
      get() {
        xmlWasRead = true;
        throw new Error("XML must not be read for invalid limits");
      },
    });
    input.limits.maxDepth = 0;

    const result = parseKohoXml(input);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("invalid_limits");
    expect(xmlWasRead).toBe(false);
  });

  it("returns invalid_limits when the limits object is missing", () => {
    const input = createFictionalKohoInput("A1") as Omit<
      KohoXmlParseInput,
      "limits"
    > & {
      limits: KohoXmlParseInput["limits"] | undefined;
    };
    let xmlWasRead = false;
    Object.defineProperty(input, "xml", {
      get() {
        xmlWasRead = true;
        throw new Error("XML must not be read when limits are missing");
      },
    });
    input.limits = undefined;
    let result: ReturnType<typeof parseKohoXml> | undefined;

    expect(() => {
      result = parseKohoXml(input as KohoXmlParseInput);
    }).not.toThrow();
    expect(result?.status).toBe("failed");
    expect(result ? issueCodes(result) : []).toEqual(["invalid_limits"]);
    expect(xmlWasRead).toBe(false);
  });

  it.each([
    "DOCUMENT/P_A1/999900/../2099000001/2099000001.xml",
    "/DOCUMENT/P_A1/999900/999990/2099000001/2099000001.xml",
    "C:\\DOCUMENT\\P_A1\\2099000001.xml",
    "\\\\fictional-server\\fictional-share\\entry.xml",
    "DOCUMENT/P_A1/999900/999990/2099000001\0/2099000001.xml",
  ])("rejects an unsafe entry path without parsing: %s", (entryPath) => {
    const input = createFictionalKohoInput("A1", { entryPath });
    let xmlWasRead = false;
    Object.defineProperty(input, "xml", {
      get() {
        xmlWasRead = true;
        throw new Error("unsafe paths must fail before XML parsing");
      },
    });

    const result = parseKohoXml(input);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["unsafe_entry_path"]);
    expect(xmlWasRead).toBe(false);
  });

  it("rejects malformed XML and discards partial fields", () => {
    const xml = createFictionalKohoInput("A1").xml as string;
    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml: xml.slice(0, -20) }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("malformed_xml");
    expect("document" in result).toBe(false);
  });

  it("rejects multiple roots and non-whitespace root-external content", () => {
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: "<FictionalRoot/><SecondFictionalRoot/>",
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("malformed_xml");
  });

  it("strictly rejects invalid UTF-8 bytes", () => {
    const invalidUtf8 = new Uint8Array([
      0x3c, 0x72, 0x6f, 0x6f, 0x74, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x72,
      0x6f, 0x6f, 0x74, 0x3e,
    ]);
    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml: invalidUtf8 }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("invalid_utf8");
  });

  it("rejects an XML declaration for a non-UTF-8 encoding", () => {
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: '<?xml version="1.0" encoding="Shift_JIS"?><FictionalRoot/>',
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("invalid_utf8");
  });

  it.each([
    '<!DOCTYPE FictionalRoot [<!ENTITY fictional "value">]><FictionalRoot/>',
    '<!DOCTYPE FictionalRoot SYSTEM "https://invalid.example/fictional.dtd"><FictionalRoot/>',
  ])("rejects general DOCTYPE declarations without resolving them", (xml) => {
    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("rejects the ST.26 DOCTYPE allowlist outside a nested ST.26 entry", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${FICTIONAL_ST26_V1_3_DOCTYPE}\n<FictionalRoot/>`;
    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("rejects the known ST.26 DOCTYPE at a primary-shaped path", () => {
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: FICTIONAL_NESTED_ST26_XML,
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("rejects the known ST.26 DOCTYPE for a namespaced lookalike root", () => {
    const xml = FICTIONAL_NESTED_ST26_XML.replace(
      '<ST26SequenceListing dtdVersion="V1_3">',
      '<ST26SequenceListing xmlns="urn:fictional:st26" dtdVersion="V1_3">',
    );
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("rejects an internal subset appended to the known ST.26 DOCTYPE", () => {
    const xml = FICTIONAL_NESTED_ST26_XML.replace(
      FICTIONAL_ST26_V1_3_DOCTYPE,
      `${FICTIONAL_ST26_V1_3_DOCTYPE.slice(0, -1)} [<!ENTITY fictional "value">]>`,
    );
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("rejects non-XML whitespace in a lookalike ST.26 DOCTYPE", () => {
    const xml = FICTIONAL_NESTED_ST26_XML.replace(
      "ST26SequenceListing PUBLIC",
      "ST26SequenceListing\u00a0PUBLIC",
    );
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("rejects an external ST.26 DTD instead of fetching it", () => {
    const xml = FICTIONAL_NESTED_ST26_XML.replace(
      "ST26SequenceListing_V1_3.dtd",
      "https://invalid.example/ST26SequenceListing_V1_3.dtd",
    );
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["doctype_forbidden"]);
  });

  it("does not mistake DOCTYPE text in comments or CDATA for a declaration", () => {
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: "<FictionalRoot><!-- <!DOCTYPE Fictional> --><![CDATA[<!DOCTYPE Fictional>]]></FictionalRoot>",
      }),
    );

    expect(result.status).toBe("unsupported_type");
    expect(issueCodes(result)).not.toContain("doctype_forbidden");
  });

  it("rejects unknown named entities without exposing surrounding text", () => {
    const confidentialLookingText = "FICTIONAL-SENSITIVE-MARKER";
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: `<FictionalRoot>${confidentialLookingText}&fictionalUnknown;</FictionalRoot>`,
      }),
    );

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("unknown_named_entity");
    expect(JSON.stringify(result.issues)).not.toContain(confidentialLookingText);
  });

  it("enforces maxXmlBytes before UTF-8 decoding", () => {
    const invalidUtf8OverLimit = new Uint8Array([0xc3, 0x28]);
    const result = parseKohoXml({
      ...createFictionalKohoInput("A1", { xml: invalidUtf8OverLimit }),
      limits: { ...FICTIONAL_KOHO_LIMITS, maxXmlBytes: 1 },
    });

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["xml_byte_limit_exceeded"]);
  });

  it.each([
    ["maxDepth", 1, "xml_depth_limit_exceeded"],
    ["maxElements", 1, "xml_element_limit_exceeded"],
    ["maxTextBytes", 1, "xml_text_limit_exceeded"],
  ] as const)("enforces %s from measured parser events", (name, limit, code) => {
    const input = createFictionalKohoInput("A1", {
      limits: { [name]: limit },
    });

    const result = parseKohoXml(input);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain(code);
  });

  it("allows byte, depth, element, and text values exactly at a limit", () => {
    const xml = "<FictionalRoot>F</FictionalRoot>";
    const input: KohoXmlParseInput = {
      packageType: "JPA",
      entryPath:
        "DOCUMENT/P_A1/999900/999990/2099000001/2099000001.xml",
      xml,
      limits: {
        maxXmlBytes: new TextEncoder().encode(xml).byteLength,
        maxDepth: 1,
        maxElements: 1,
        maxTextBytes: 1,
      },
    };

    const result = parseKohoXml(input);

    expect(result.status).toBe("unsupported_type");
    expect(issueCodes(result)).toEqual(["unknown_namespace"]);
  });

  it("distinguishes an unknown root from an unknown namespace", () => {
    const unknownRoot = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: '<j:FuturePublication xmlns:j="http://www.jpo.go.jp/standards/XMLSchema/ST96/JPPatent"/>',
      }),
    );
    const unknownNamespace = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: '<j:UnexaminedPatentPublication xmlns:j="urn:fictional:unknown"/>',
      }),
    );

    expect(unknownRoot.status).toBe("unsupported_type");
    expect(issueCodes(unknownRoot)).toContain("unknown_root");
    expect(unknownNamespace.status).toBe("unsupported_type");
    expect(issueCodes(unknownNamespace)).toContain("unknown_namespace");
  });

  it("assigns deterministic paths to a large sibling set", () => {
    const siblingCount = 32_000;
    const xml = `<FictionalRoot>${"<FictionalItem/>".repeat(siblingCount)}</FictionalRoot>`;

    const result = parseXmlTree(xml, {
      maxXmlBytes: 1_048_576,
      maxDepth: 2,
      maxElements: siblingCount + 1,
      maxTextBytes: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected a parsed tree, got ${result.code}`);
    }
    const lastChild = result.root.children.at(-1);
    expect(lastChild?.type).toBe("element");
    if (lastChild?.type !== "element") {
      throw new Error("expected an element child");
    }
    expect(
      Object.getOwnPropertyDescriptor(lastChild.element, "sourcePath")?.get,
    ).toBeTypeOf("function");
    expect(lastChild.element.sourcePath).toBe(
      "/FictionalRoot[1]/FictionalItem[32000]",
    );
  });
});
