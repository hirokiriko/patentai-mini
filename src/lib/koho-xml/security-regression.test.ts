import { describe, expect, it } from "vitest";

import {
  FICTIONAL_KOHO_LIMITS,
  FICTIONAL_NESTED_ST26_ENTRY_PATH,
  FICTIONAL_NESTED_ST26_XML,
  buildFictionalAmendmentXml,
  buildFictionalFullPublicationXml,
  createFictionalKohoInput,
} from "./__fixtures__/fictional-koho";
import { parseKohoXml } from "./index";
import type {
  KohoAmendmentDocument,
  KohoContentToken,
  KohoFullPublicationDocument,
  KohoXmlParseResult,
} from "./index";

const JP_PATENT_NAMESPACE =
  "http://www.jpo.go.jp/standards/XMLSchema/ST96/JPPatent";
const COMMON_NAMESPACE =
  "http://www.wipo.int/standards/XMLSchema/ST96/Common";
const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

function replaceRequired(
  source: string,
  target: string,
  replacement: string,
): string {
  expect(source.includes(target)).toBe(true);
  return source.replace(target, replacement);
}

function issueCodes(result: KohoXmlParseResult): string[] {
  return result.issues.map((issue) => issue.code);
}

function extractedFull(
  result: KohoXmlParseResult,
): KohoFullPublicationDocument {
  if (!("document" in result)) {
    throw new Error(`expected a full-publication result, got ${result.entryType}`);
  }
  const document = result.document ?? result.candidate;
  if (!document) {
    throw new Error("expected an extracted full-publication document");
  }
  return document;
}

function extractedAmendment(
  result: KohoXmlParseResult,
): KohoAmendmentDocument {
  if (!("amendment" in result)) {
    throw new Error(`expected an amendment result, got ${result.entryType}`);
  }
  const amendment = result.amendment ?? result.candidate;
  if (!amendment) {
    throw new Error("expected an extracted amendment document");
  }
  return amendment;
}

function expectUnconfirmedIdentity(result: KohoXmlParseResult): void {
  if (!("identityConfirmed" in result)) {
    throw new Error("expected identity confirmation metadata");
  }
  expect(result.identityConfirmed).toBe(false);
}

describe("parseKohoXml security regressions", () => {
  it("prototype継承名のrootを例外化せずunknown_rootへ分類する", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jppat:__proto__
  xmlns:jppat="${JP_PATENT_NAMESPACE}"
  xmlns:com="${COMMON_NAMESPACE}"
  xmlns:xsi="${XSI_NAMESPACE}"
  xsi:schemaLocation="${JP_PATENT_NAMESPACE} ../../../../../XSD/FICTIONAL-UNKNOWN-ROOT.xsd"
  com:st96Version="V3_1"
  com:ipoVersion="JP_V1_0"
  com:languageCode="ja"/>`;
    let result: KohoXmlParseResult | undefined;

    expect(() => {
      result = parseKohoXml({
        packageType: "JPB",
        entryPath: "DOCUMENT/P_B1/999900/999990/9999999/9999999.xml",
        xml,
        indexHint: {
          kindCode: "B1",
          publicationNumber: "9999999",
          publicationDate: "20990101",
        },
        limits: FICTIONAL_KOHO_LIMITS,
      });
    }).not.toThrow();
    if (!result) {
      throw new Error("expected a parse result");
    }

    expect(result.status).toBe("unsupported_type");
    expect(result.entryType).toBe("unknown");
    expect(result.kind).toBeNull();
    expect(issueCodes(result)).toEqual(["unknown_root"]);
  });

  it("schemaLocationの追加外部pairを無視せず候補隔離する", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const expectedSchema =
      `xsi:schemaLocation="${JP_PATENT_NAMESPACE} ` +
      "../../../../../XSD/JPUnexaminedPatentPublication_V1_0.xsd";
    const xml = replaceRequired(
      baseXml,
      `${expectedSchema}"`,
      `${expectedSchema} urn:fictional-extra https://example.invalid/FICTIONAL-EXTERNAL.xsd"`,
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("schema_mismatch");
    expectUnconfirmedIdentity(result);
    if (!("document" in result)) {
      throw new Error("expected a full-publication candidate");
    }
    expect(result.document).toBeNull();
    expect(result.candidate?.kind).toBe("A1");
  });

  it("claim内部spaceを保持しつつ外側の整形indentを本文へ混入させない", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      claims: [{ number: "1", text: "FICTIONAL-CLAIM-SPACE" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-CLAIM-SPACE",
      "FICTIONAL-CLAIM-A</pat:ClaimText> <pat:ClaimText>FICTIONAL-CLAIM-B",
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("success");
    const claim = extractedFull(result).claims[0];
    expect(claim.plainText).toBe("FICTIONAL-CLAIM-A FICTIONAL-CLAIM-B");
    expect(claim.plainText).toBe(claim.plainText.trim());
    expect(claim.plainText).not.toContain("\n");
  });

  it("比較前にA1番号のraw formatを検査する", () => {
    const invalidNumber = "20-99000001";
    const xml = buildFictionalFullPublicationXml("A1", {
      publicationNumber: invalidNumber,
    });
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        entryPath: `DOCUMENT/P_A1/999900/999990/${invalidNumber}/${invalidNumber}.xml`,
        indexHint: {
          kindCode: "A",
          publicationNumber: invalidNumber,
          publicationDate: "20990111",
        },
      }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("publication_number_mismatch");
    expectUnconfirmedIdentity(result);
    expect(extractedFull(result).publicationNumber.sourceValue).toBe(
      invalidNumber,
    );
  });

  it("AbstractとDescriptionで既知Pに隣接する未知nodeを順序どおり保持する", () => {
    let xml = buildFictionalFullPublicationXml("A1", {
      abstract: "FICTIONAL-ABSTRACT-PARAGRAPH",
      paragraphs: [
        { number: "0901", text: "FICTIONAL-DESCRIPTION-PARAGRAPH" },
      ],
    });
    xml = replaceRequired(
      xml,
      "  <pat:Abstract>\n",
      "  <pat:Abstract>\n" +
        '    <evil:FictionalAbstractSibling xmlns:evil="urn:fictional-evil">FICTIONAL-ABSTRACT-UNKNOWN</evil:FictionalAbstractSibling>\n',
    );
    xml = replaceRequired(
      xml,
      "  <jppat:Description>\n",
      "  <jppat:Description>\n" +
        '    <evil:FictionalDescriptionSibling xmlns:evil="urn:fictional-evil">FICTIONAL-DESCRIPTION-UNKNOWN</evil:FictionalDescriptionSibling>\n',
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("review_required");
    expect(
      result.issues.filter((issue) => issue.code === "unknown_inline_element"),
    ).toHaveLength(2);
    const document = extractedFull(result);
    const abstractText = document.abstract?.plainText ?? "";
    expect(abstractText).toContain("FICTIONAL-ABSTRACT-UNKNOWN");
    expect(abstractText).toContain("FICTIONAL-ABSTRACT-PARAGRAPH");
    expect(abstractText.indexOf("FICTIONAL-ABSTRACT-UNKNOWN")).toBeLessThan(
      abstractText.indexOf("FICTIONAL-ABSTRACT-PARAGRAPH"),
    );
    const descriptionText = document.description
      .map((paragraph) => paragraph.plainText)
      .join("\n");
    expect(descriptionText).toContain("FICTIONAL-DESCRIPTION-UNKNOWN");
    expect(descriptionText).toContain("FICTIONAL-DESCRIPTION-PARAGRAPH");
    expect(
      descriptionText.indexOf("FICTIONAL-DESCRIPTION-UNKNOWN"),
    ).toBeLessThan(
      descriptionText.indexOf("FICTIONAL-DESCRIPTION-PARAGRAPH"),
    );
  });

  it("media内のevil QNameを既知filenameとして採用せず内容を保持する", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0902", text: "FICTIONAL-MEDIA-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-MEDIA-INSERTION",
      '<com:Image xmlns:evil="urn:fictional-evil">' +
        "<evil:FileName>FICTIONAL-EVIL-TARGET.tif</evil:FileName>" +
        "<evil:FictionalMediaPayload>FICTIONAL-EVIL-MEDIA</evil:FictionalMediaPayload>" +
        "</com:Image>",
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_inline_element");
    const paragraph = extractedFull(result).description[0];
    expect(paragraph.plainText).toContain("FICTIONAL-EVIL-MEDIA");
    expect(JSON.stringify(paragraph.content.tokens)).toContain(
      "FictionalMediaPayload",
    );
    const imageToken = paragraph.content.tokens.find(
      (token) => token.type === "image_reference",
    );
    expect(imageToken?.type).toBe("image_reference");
    if (imageToken?.type !== "image_reference") {
      throw new Error("expected an image-reference token");
    }
    expect(imageToken.reference.sourceTarget).toBeNull();
  });

  it("既知のtable image metadataをunknown扱いせず単一referenceで保持する", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0903", text: "FICTIONAL-TABLE-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-TABLE-INSERTION",
      "<com:Table><com:TableImage><com:Image>" +
        "<com:FileName>FICTIONAL-table-metadata.tif</com:FileName>" +
        "<com:ImageFormatCategory>TIFF</com:ImageFormatCategory>" +
        '<com:HeightMeasure com:measureUnitCode="px">42</com:HeightMeasure>' +
        "</com:Image></com:TableImage></com:Table>",
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("success");
    expect(result.issues).toEqual([]);
    const paragraph = extractedFull(result).description[0];
    const referenceTokens = paragraph.content.tokens.filter((token) =>
      [
        "image_reference",
        "table_reference",
        "math_reference",
        "chemical_formula_reference",
      ].includes(token.type),
    );
    expect(referenceTokens.map((token) => token.type)).toEqual([
      "table_reference",
    ]);
    const tableToken = referenceTokens[0];
    if (tableToken?.type !== "table_reference") {
      throw new Error("expected a table-reference token");
    }
    expect(tableToken.reference.sourceTarget).toBe(
      "FICTIONAL-table-metadata.tif",
    );
    expect(tableToken.reference.preservedText).toContain("TIFF");
    expect(tableToken.reference.preservedText).toContain("42");
    expect(tableToken.reference.metadata).toEqual({
      imageFormatCategory: { sourceValue: "TIFF", value: "TIFF" },
      heightMeasure: {
        sourceValue: "42",
        value: "42",
        measureUnitCode: "px",
      },
      widthMeasure: null,
      imageContentCategory: null,
    });
    expect(tableToken.reference.source.localName).toBe("Table");
    expect(extractedFull(result).references.map((item) => item.kind)).toEqual([
      "table_image",
    ]);
  });

  it.each([
    ["foreign namespace", 'evil:FictionalWrapper xmlns:evil="urn:fictional-evil"'],
    ["known namespace unknown QName", "jppat:FictionalUnknownContainer"],
  ])("Description内の%sをQNameごと保持する", (_label, wrapperName) => {
    let xml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0910", text: "FICTIONAL-WRAPPED-PARAGRAPH" }],
    });
    xml = replaceRequired(
      xml,
      "  <jppat:Description>\n",
      `  <jppat:Description>\n    <${wrapperName}>\n`,
    );
    xml = replaceRequired(
      xml,
      "  </jppat:Description>",
      `    </${wrapperName.split(" ")[0]}>\n  </jppat:Description>`,
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_inline_element");
    const paragraph = extractedFull(result).description[0];
    expect(paragraph.plainText).toContain("FICTIONAL-WRAPPED-PARAGRAPH");
    expect(JSON.stringify(paragraph.content.tokens)).toContain(
      wrapperName.includes("evil:")
        ? "FictionalWrapper"
        : "FictionalUnknownContainer",
    );
  });

  it("FigureReferenceとPatentCitation内部の未知QNameをsourceごと保持する", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0911", text: "FICTIONAL-TERMINAL-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-TERMINAL-INSERTION",
      '<com:FigureReference xmlns:evil="urn:fictional-evil" com:referencedFigureNumber="9">' +
        "<evil:InjectedFigurePayload>FICTIONAL-FIGURE-PAYLOAD</evil:InjectedFigurePayload>" +
        "</com:FigureReference>" +
        "<pat:PatentCitation><pat:FictionalUnknownCitation>FICTIONAL-CITATION-PAYLOAD</pat:FictionalUnknownCitation></pat:PatentCitation>",
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("review_required");
    expect(
      result.issues.filter((item) => item.code === "unknown_inline_element"),
    ).toHaveLength(2);
    const tokens = extractedFull(result).description[0].content.tokens;
    const figure = tokens.find((token) => token.type === "figure_reference");
    const citation = tokens.find((token) => token.type === "patent_citation");
    if (figure?.type !== "figure_reference") {
      throw new Error("expected a figure-reference token");
    }
    if (citation?.type !== "patent_citation") {
      throw new Error("expected a patent-citation token");
    }
    expect(JSON.stringify(figure.reference.source)).toContain(
      "InjectedFigurePayload",
    );
    expect(JSON.stringify(citation.source)).toContain(
      "FictionalUnknownCitation",
    );
  });

  it("Drawingsの本文外imageを寸法metadata付きsidecarに保持する", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const drawing =
      "  <pat:Drawings><pat:Figure><com:Image>" +
      "<com:FileName>FICTIONAL-DRAWING-0001.tif</com:FileName>" +
      "<com:ImageFormatCategory>TIFF</com:ImageFormatCategory>" +
      '<com:HeightMeasure com:measureUnitCode="px">42</com:HeightMeasure>' +
      '<com:WidthMeasure com:measureUnitCode="px">84</com:WidthMeasure>' +
      "</com:Image></pat:Figure></pat:Drawings>\n";
    const xml = replaceRequired(
      baseXml,
      "</jppat:UnexaminedPatentPublication>",
      `${drawing}</jppat:UnexaminedPatentPublication>`,
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("success");
    const references = extractedFull(result).references;
    expect(references).toHaveLength(1);
    expect(references[0]).toEqual(
      expect.objectContaining({
        ordinal: 1,
        kind: "drawing",
        sourceEntryPath: expect.stringContaining("DOCUMENT/P_A1/"),
      }),
    );
    expect(references[0].reference.sourceTarget).toBe(
      "FICTIONAL-DRAWING-0001.tif",
    );
    expect(references[0].reference.sourcePath).toContain("/Drawings[1]/Figure[1]/Image[1]");
    expect(references[0].reference.metadata.heightMeasure).toEqual({
      sourceValue: "42",
      value: "42",
      measureUnitCode: "px",
    });
    expect(references[0].reference.metadata.widthMeasure).toEqual({
      sourceValue: "84",
      value: "84",
      measureUnitCode: "px",
    });
  });

  it("does not confirm a media filename with nested scalar content", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const drawing =
      "  <pat:Drawings><pat:Figure><com:Image>" +
      "<com:FileName>" +
      '<evil:FictionalFileName xmlns:evil="urn:fictional-evil">' +
      "FICTIONAL-NESTED-FILENAME.tif</evil:FictionalFileName>" +
      "</com:FileName>" +
      "</com:Image></pat:Figure></pat:Drawings>\n";
    const xml = replaceRequired(
      baseXml,
      "</jppat:UnexaminedPatentPublication>",
      `${drawing}</jppat:UnexaminedPatentPublication>`,
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_inline_element");
    const reference = extractedFull(result).references[0].reference;
    expect(reference.sourceTarget).toBe("FICTIONAL-NESTED-FILENAME.tif");
    expect(reference.normalizedTarget).toBeNull();
    expect(reference.resolution).toBe("rejected");
    expect(reference.unmodeledScalarPaths).toHaveLength(1);
    expect(JSON.stringify(reference.source)).toContain("FictionalFileName");
  });

  it("limit内の深いmixed contentを例外化せず決定的に処理する", () => {
    const depth = 5_000;
    const deepContent =
      "<com:B>".repeat(depth) +
      "FICTIONAL-DEEP-CONTENT" +
      "</com:B>".repeat(depth);
    const baseXml = buildFictionalFullPublicationXml("A1", {
      claims: [{ number: "1", text: "FICTIONAL-DEEP-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-DEEP-INSERTION",
      deepContent,
    );
    const input = createFictionalKohoInput("A1", {
      xml,
      limits: {
        maxXmlBytes: 1_048_576,
        maxDepth: 5_100,
        maxElements: 5_200,
        maxTextBytes: 524_288,
      },
    });
    let result: KohoXmlParseResult | undefined;

    expect(() => {
      result = parseKohoXml(input);
    }).not.toThrow();
    expect(result?.status).toBe("success");
    if (!result) {
      throw new Error("expected a parse result");
    }
    expect(extractedFull(result).claims[0].plainText).toBe(
      "FICTIONAL-DEEP-CONTENT",
    );
  });

  it("aggregates a deeply nested unknown subtree into one diagnostic", () => {
    const depth = 4_000;
    const deepUnknown =
      '<evil:FictionalUnknown xmlns:evil="urn:fictional-evil">' +
      "<evil:FictionalUnknown>".repeat(depth - 1) +
      "FICTIONAL-DEEP-UNKNOWN" +
      "</evil:FictionalUnknown>".repeat(depth);
    const baseXml = buildFictionalFullPublicationXml("A1", {
      claims: [{ number: "1", text: "FICTIONAL-DEEP-UNKNOWN-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-DEEP-UNKNOWN-INSERTION",
      deepUnknown,
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        limits: {
          maxXmlBytes: 1_048_576,
          maxDepth: 4_100,
          maxElements: 4_200,
          maxTextBytes: 524_288,
        },
      }),
    );

    expect(result.status).toBe("review_required");
    expect(
      result.issues.filter((item) => item.code === "unknown_inline_element"),
    ).toHaveLength(1);
    expect(extractedFull(result).claims[0].plainText).toBe(
      "FICTIONAL-DEEP-UNKNOWN",
    );
  });

  it("materializes nested unknown and script text only at the outer token", () => {
    const depth = 600;
    const openings: string[] = [];
    const closings: string[] = [];
    let expected = "FICTIONAL-NESTED-LEAF";

    for (let index = 0; index < depth; index += 1) {
      const layerText = `FICTIONAL-LAYER-${index}|`;
      if (index % 3 === 0) {
        openings.push(
          index === 0
            ? '<evil:FictionalUnknown xmlns:evil="urn:fictional-evil">' +
                layerText
            : `<evil:FictionalUnknown>${layerText}`,
        );
        closings.push("</evil:FictionalUnknown>");
      } else if (index % 3 === 1) {
        openings.push(`<com:Sub>${layerText}`);
        closings.push("</com:Sub>");
      } else {
        openings.push(`<com:Sup>${layerText}`);
        closings.push("</com:Sup>");
      }
    }
    for (let index = depth - 1; index >= 0; index -= 1) {
      const layerText = `FICTIONAL-LAYER-${index}|`;
      expected =
        index % 3 === 0
          ? `${layerText}${expected}`
          : `${index % 3 === 1 ? "_{" : "^{"}${layerText}${expected}}`;
    }

    const deepContent =
      openings.join("") +
      "FICTIONAL-NESTED-LEAF" +
      closings.reverse().join("");
    const baseXml = buildFictionalFullPublicationXml("A1", {
      claims: [{ number: "1", text: "FICTIONAL-NESTED-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-NESTED-INSERTION",
      deepContent,
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        limits: {
          maxXmlBytes: 1_048_576,
          maxDepth: 700,
          maxElements: 800,
          maxTextBytes: 524_288,
        },
      }),
    );

    expect(result.status).toBe("review_required");
    expect(
      result.issues.filter((item) => item.code === "unknown_inline_element"),
    ).toHaveLength(1);
    const claim = extractedFull(result).claims[0];
    expect(claim.plainText).toBe(expected);
    const pending: KohoContentToken[] = [...claim.content.tokens];
    const structured: Array<
      Extract<
        KohoContentToken,
        { type: "unknown_inline_element" | "subscript" | "superscript" }
      >
    > = [];
    while (pending.length > 0) {
      const token = pending.pop();
      if (
        token?.type !== "unknown_inline_element" &&
        token?.type !== "subscript" &&
        token?.type !== "superscript"
      ) {
        continue;
      }
      structured.push(token);
      pending.push(...token.content);
    }
    expect(structured).toHaveLength(depth);
    expect(structured[0].plainText).toBe(expected);
    expect(structured.slice(1).every((token) => token.plainText === null)).toBe(
      true,
    );
  });

  it("preserves a B2 abstract when a future source provides one", () => {
    const xml = buildFictionalFullPublicationXml("B2", {
      abstract: "FICTIONAL-UNEXPECTED-B2-ABSTRACT",
    });

    const result = parseKohoXml(createFictionalKohoInput("B2", { xml }));

    expect(result.status).toBe("success");
    expect(extractedFull(result).abstract?.plainText).toBe(
      "FICTIONAL-UNEXPECTED-B2-ABSTRACT",
    );
  });

  it("extracts only outermost amendment Claims subtrees", () => {
    const depth = 400;
    const nestedClaims =
      (
        "<pat:Claims><pat:Claim>" +
        "<pat:ClaimNumber>999</pat:ClaimNumber><pat:ClaimText>"
      ).repeat(depth) +
      "FICTIONAL-NESTED-AMENDMENT-LEAF" +
      "</pat:ClaimText></pat:Claim></pat:Claims>".repeat(depth);
    const baseXml = buildFictionalAmendmentXml("A5", {
      amendedClaims: [
        { number: "1", text: "FICTIONAL-AMENDMENT-INSERTION" },
      ],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-AMENDMENT-INSERTION",
      nestedClaims,
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A5", {
        xml,
        limits: {
          maxXmlBytes: 1_048_576,
          maxDepth: 1_300,
          maxElements: 2_000,
          maxTextBytes: 524_288,
        },
      }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expect(result.issues.length).toBeLessThan(10);
    const amendment = extractedAmendment(result);
    expect(amendment.amendedClaims).toHaveLength(1);
    expect(amendment.amendedClaims[0].claimNumber).toBe("1");
    expect(amendment.amendedClaims[0].plainText).toContain(
      "FICTIONAL-NESTED-AMENDMENT-LEAF",
    );
  });

  it("shares classification container attributes without per-item copying", () => {
    const count = 500;
    const ipc = Array.from(
      { length: count },
      (_unused, index) => `FICTIONAL-IPC-${index}`,
    );
    const attributes = Array.from(
      { length: count },
      (_unused, index) => ` fictionalAttribute${index}="${index}"`,
    ).join("");
    const baseXml = buildFictionalFullPublicationXml("A1", { ipc });
    const xml = replaceRequired(
      baseXml,
      "<jppat:IPCClassification>",
      `<jppat:IPCClassification${attributes}>`,
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("success");
    const classifications = extractedFull(result).ipc;
    expect(classifications).toHaveLength(count);
    expect(Object.keys(classifications[0].attributes.container)).toHaveLength(
      count,
    );
    expect(
      classifications.every(
        (classification) =>
          classification.attributes.container ===
          classifications[0].attributes.container,
      ),
    ).toBe(true);
  });

  it("direct PublicationNumber重複を成功recordとして確定しない", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "</pat:PublicationNumber>",
      "</pat:PublicationNumber>" +
        "<pat:PublicationNumber>1111111111</pat:PublicationNumber>",
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", { xml }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expectUnconfirmedIdentity(result);
    if (!("document" in result)) {
      throw new Error("expected an unconfirmed full-publication candidate");
    }
    expect(result.document).toBeNull();
    expect(result.candidate?.publicationNumber.value).toBe("2099000001");
  });

  it("does not confirm an identity scalar that contains an unknown child", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "<pat:PublicationNumber>2099000001</pat:PublicationNumber>",
      '<pat:PublicationNumber><evil:FictionalNumber xmlns:evil="urn:fictional-evil">' +
        "2099000001</evil:FictionalNumber></pat:PublicationNumber>",
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_inline_element");
    expectUnconfirmedIdentity(result);
    if (!("document" in result)) {
      throw new Error("expected an unconfirmed full-publication candidate");
    }
    expect(result.document).toBeNull();
    expect(result.candidate?.publicationNumber.value).toBe("2099000001");
    expect(
      JSON.stringify(result.candidate?.publicationNumber.sourceElement),
    ).toContain("FictionalNumber");
  });

  it("ST26のnamespaced evil:dtdVersionをunqualified属性として採用しない", () => {
    const xml = replaceRequired(
      FICTIONAL_NESTED_ST26_XML,
      '<ST26SequenceListing dtdVersion="V1_3">',
      '<ST26SequenceListing xmlns:evil="urn:fictional-evil" evil:dtdVersion="V1_3">',
    );

    const result = parseKohoXml({
      packageType: "JPA",
      entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
      xml,
      limits: FICTIONAL_KOHO_LIMITS,
    });

    expect(result.status).toBe("review_required");
    expect(result.entryType).toBe("nested_st26");
    expect(issueCodes(result)).toContain("version_mismatch");
    expectUnconfirmedIdentity(result);
    if (!("nestedSt26" in result)) {
      throw new Error("expected a nested ST.26 result");
    }
    expect(result.nestedSt26.dtdVersion).toBeNull();
  });

  it("keeps every media target when duplicate FileName values conflict", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0912", text: "FICTIONAL-DUPLICATE-TARGET" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-DUPLICATE-TARGET",
      "<com:Image>" +
        "<com:FileName>FICTIONAL-SAFE-IMAGE.tif</com:FileName>" +
        "<com:FileName>../FICTIONAL-UNSAFE-IMAGE.tif</com:FileName>" +
        "</com:Image>",
    );

    const result = parseKohoXml(createFictionalKohoInput("A1", { xml }));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expect(issueCodes(result)).toContain("unsafe_reference_target");
    if (!("identityConfirmed" in result)) {
      throw new Error("expected identity confirmation metadata");
    }
    expect(result.identityConfirmed).toBe(true);
    if (!("document" in result)) {
      throw new Error("expected a full-publication result");
    }
    expect(result.document).not.toBeNull();
    const image = extractedFull(result).description[0].content.tokens.find(
      (token) => token.type === "image_reference",
    );
    if (image?.type !== "image_reference") {
      throw new Error("expected an image-reference token");
    }
    expect(image.reference.sourceTargets).toEqual([
      "FICTIONAL-SAFE-IMAGE.tif",
      "../FICTIONAL-UNSAFE-IMAGE.tif",
    ]);
    expect(image.reference.sourceTarget).toBe("FICTIONAL-SAFE-IMAGE.tif");
    expect(image.reference.normalizedTarget).toBeNull();
    expect(image.reference.resolution).toBe("rejected");
  });

  it("handles deeply nested media without throwing or duplicating sidecar entries", () => {
    const depth = 5_000;
    const deepMedia =
      "<com:Image>".repeat(depth) +
      "<com:FileName>FICTIONAL-DEEP-IMAGE.tif</com:FileName>" +
      "</com:Image>".repeat(depth);
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0913", text: "FICTIONAL-DEEP-MEDIA" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-DEEP-MEDIA",
      deepMedia,
    );
    let result: KohoXmlParseResult | undefined;

    expect(() => {
      result = parseKohoXml(
        createFictionalKohoInput("A1", {
          xml,
          limits: {
            maxXmlBytes: 1_048_576,
            maxDepth: 5_100,
            maxElements: 5_200,
            maxTextBytes: 524_288,
          },
        }),
      );
    }).not.toThrow();
    if (!result) {
      throw new Error("expected a parse result");
    }
    expect(result.status).toBe("success");
    expect(extractedFull(result).references).toHaveLength(1);
    expect(extractedFull(result).references[0].reference.sourceTargets).toEqual([
      "FICTIONAL-DEEP-IMAGE.tif",
    ]);
  });

  it("does not resnapshot each nested media container", () => {
    const depth = 500;
    const deepTable =
      "<com:Table>".repeat(depth) +
      "<com:TableImage><com:Image>" +
      "<com:FileName>FICTIONAL-DEEP-TABLE.tif</com:FileName>" +
      "</com:Image></com:TableImage>" +
      "</com:Table>".repeat(depth);
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0915", text: "FICTIONAL-DEEP-TABLE" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-DEEP-TABLE",
      deepTable,
    );

    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        limits: {
          maxXmlBytes: 1_048_576,
          maxDepth: 600,
          maxElements: 700,
          maxTextBytes: 524_288,
        },
      }),
    );

    expect(result.status).toBe("success");
    const document = extractedFull(result);
    expect(document.references).toHaveLength(1);
    expect(document.references[0].kind).toBe("table_image");
    expect(document.references[0].reference.sourceTargets).toEqual([
      "FICTIONAL-DEEP-TABLE.tif",
    ]);
    expect(
      document.description[0].content.tokens.filter(
        (token) => token.type === "table_reference",
      ),
    ).toHaveLength(1);
  });

  it("walks deeply nested known description containers in one pass", () => {
    const depth = 4_000;
    let xml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0914", text: "FICTIONAL-DEEP-DESCRIPTION" }],
    });
    xml = replaceRequired(
      xml,
      "  <jppat:Description>\n",
      "  <jppat:Description>\n" +
        "<jppat:DescriptionOfEmbodiments>".repeat(depth),
    );
    xml = replaceRequired(
      xml,
      "  </jppat:Description>",
      "</jppat:DescriptionOfEmbodiments>".repeat(depth) +
        "\n  </jppat:Description>",
    );
    let result: KohoXmlParseResult | undefined;

    expect(() => {
      result = parseKohoXml(
        createFictionalKohoInput("A1", {
          xml,
          limits: {
            maxXmlBytes: 1_048_576,
            maxDepth: 4_100,
            maxElements: 4_200,
            maxTextBytes: 524_288,
          },
        }),
      );
    }).not.toThrow();
    if (!result) {
      throw new Error("expected a parse result");
    }
    expect(result.status).toBe("success");
    expect(extractedFull(result).description).toEqual([
      expect.objectContaining({
        ordinal: 1,
        paragraphNumber: "0914",
        plainText: "FICTIONAL-DEEP-DESCRIPTION",
      }),
    ]);
  });

  it("requires the ST.26 package type to agree with the enclosing section", () => {
    const result = parseKohoXml({
      ...createFictionalKohoInput("A1", {
        xml: FICTIONAL_NESTED_ST26_XML,
        entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
        indexHint: null,
      }),
      packageType: "JPB",
    });

    expect(result.status).toBe("review_required");
    expect(result.entryType).toBe("nested_st26");
    expect(issueCodes(result)).toContain("package_type_mismatch");
    expectUnconfirmedIdentity(result);
  });
});
