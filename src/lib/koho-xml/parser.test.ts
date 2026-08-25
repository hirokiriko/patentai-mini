import { describe, expect, it } from "vitest";

import { parseKohoXml } from "./index";
import type {
  KohoAmendmentDocument,
  KohoFullPublicationDocument,
  KohoXmlParseInput,
  KohoXmlParseResult,
} from "./index";
import {
  buildFictionalAmendmentXml,
  buildFictionalFullPublicationXml,
  createFictionalKohoInput,
  FICTIONAL_NESTED_ST26_ENTRY_PATH,
  FICTIONAL_NESTED_ST26_XML,
  FICTIONAL_ST26_V1_3_DOCTYPE,
  fictionalPrimaryEntryPath,
  type FictionalFullPublicationXmlOptions,
} from "./__fixtures__/fictional-koho";

const FULL_KINDS = ["A1", "P1", "B1", "B2"] as const;
const AMENDMENT_KINDS = ["A5", "P5"] as const;

function issueCodes(result: KohoXmlParseResult): string[] {
  return result.issues.map((issue) => issue.code);
}

function issuesFor(result: KohoXmlParseResult, code: string) {
  return result.issues.filter((issue) => issue.code === code);
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

function expectSuccess(result: KohoXmlParseResult): void {
  expect(result.status).toBe("success");
  expect(result.issues).toEqual([]);
}

function replaceRequired(source: string, target: string, replacement: string) {
  expect(source.includes(target)).toBe(true);
  return source.replace(target, replacement);
}

function withXml(
  kind: Parameters<typeof createFictionalKohoInput>[0],
  xml: string | Uint8Array,
  overrides: Partial<KohoXmlParseInput> = {},
): KohoXmlParseInput {
  return {
    ...createFictionalKohoInput(kind),
    ...overrides,
    xml,
  };
}

describe("parseKohoXml success cases", () => {
  it.each(FULL_KINDS)("%s full publicationを構造化抽出する", (kind) => {
    const result = parseKohoXml(createFictionalKohoInput(kind));

    expectSuccess(result);
    expect(result.entryType).toBe("full_publication");
    expect(result.kind).toBe(kind);
    if (!("identityConfirmed" in result)) {
      throw new Error("expected identity confirmation metadata");
    }
    expect(result.identityConfirmed).toBe(true);

    const document = extractedFull(result);
    expect(document.kind).toBe(kind);
    expect(document.applicationNumber.value).toContain("FICTIONAL-APPLICATION");
    expect(document.publicationDate.value).toMatch(/^2099-/);
    expect(document.registrationNumber?.value ?? null).toBe(
      kind === "B1" || kind === "B2"
        ? document.publicationNumber.value
        : null,
    );
    expect(document.plainLanguageDesignation?.value ?? null).toBe(
      kind === "B1" || kind === "B2" ? `特許公報(${kind})` : null,
    );
    expect(document.abstract).toEqual(
      kind === "B2" ? null : expect.objectContaining({ plainText: expect.any(String) }),
    );
  });

  it.each(AMENDMENT_KINDS)("%s amendment eventを別recordとして抽出する", (kind) => {
    const result = parseKohoXml(createFictionalKohoInput(kind));

    expectSuccess(result);
    expect(result.entryType).toBe("amendment");
    expect(result.kind).toBe(kind);
    const amendment = extractedAmendment(result);
    expect(amendment.kind).toBe(kind);
    expect(amendment.applicationNumber.value).toContain("FICTIONAL-APPLICATION");
    expect(amendment.writtenAmendmentFilingDates.map((date) => date.value)).toEqual([
      "2099-01-01",
      "2099-01-02",
    ]);
    expect(amendment.amendedClaims.map((claim) => claim.claimNumber)).toEqual([
      "1",
      "2",
    ]);
    expect(amendment.contentExtraction).toBe("structured_snapshot");
    expect(amendment.amendmentContent.localName).toBe("WrittenAmendmentBag");
    expect(amendment.nationalPublicationNumber?.value ?? null).toBe(
      kind === "P5" ? "FICTIONAL-NATIONAL-PUBLICATION-P5" : null,
    );
  });

  it("既知DOCTYPE付きのdeeper ST.26 XMLを解決せずprimaryとは別に識別する", () => {
    const input = createFictionalKohoInput("A1", {
      xml: FICTIONAL_NESTED_ST26_XML,
      entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
    });
    const result = parseKohoXml(input);

    expectSuccess(result);
    expect(result.entryType).toBe("nested_st26");
    expect(result.kind).toBeNull();
    expect(FICTIONAL_NESTED_ST26_XML).toContain(
      FICTIONAL_ST26_V1_3_DOCTYPE,
    );
    if (!("nestedSt26" in result)) {
      throw new Error("expected nested ST.26 metadata");
    }
    expect(result.nestedSt26).toEqual({
      dtdVersion: "V1_3",
      contentParsed: false,
    });
  });

  it("prefix名が全て変わってもnamespace URIでA1を抽出する", () => {
    const xml = buildFictionalFullPublicationXml("A1", {
      prefixes: {
        jppat: "fixtureJpPatent",
        jpcom: "fixtureJpCommon",
        pat: "fixturePatent",
        com: "fixtureCommon",
        xsi: "fixtureXsi",
      },
    });
    const result = parseKohoXml(withXml("A1", xml));

    expectSuccess(result);
    expect(result.source.rootLocalName).toBe("UnexaminedPatentPublication");
    expect(result.source.rootNamespaceUri).toBe(
      "http://www.jpo.go.jp/standards/XMLSchema/ST96/JPPatent",
    );
    expect(extractedFull(result).publicationNumber.value).toBe("2099000001");
  });
});

describe("parseKohoXml repeated fields and mixed content", () => {
  it("abstract paragraph boundaries ignore XML formatting whitespace", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      abstract: "FICTIONAL-ABSTRACT-ONE",
    });
    const xml = replaceRequired(
      baseXml,
      "  </pat:Abstract>",
      "    <com:P com:pNumber=\"0002\">FICTIONAL-ABSTRACT-TWO</com:P>\n" +
        "  </pat:Abstract>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expectSuccess(result);
    const abstract = extractedFull(result).abstract;
    expect(abstract?.plainText).toBe(
      "FICTIONAL-ABSTRACT-ONE\nFICTIONAL-ABSTRACT-TWO",
    );
    expect(abstract?.tokens).toEqual([
      { type: "text", text: "FICTIONAL-ABSTRACT-ONE" },
      { type: "boundary", boundary: "paragraph" },
      { type: "text", text: "FICTIONAL-ABSTRACT-TWO" },
      { type: "boundary", boundary: "paragraph" },
    ]);
  });

  it("keeps an embedded full-publication amendment as a separate snapshot", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const embeddedAmendment =
      "  <jppat:WrittenAmendmentBag>" +
      "<jppat:WrittenAmendment>" +
      "<pat:FilingDate>2099-02-01</pat:FilingDate>" +
      "<pat:Claims><pat:Claim><pat:ClaimNumber>99</pat:ClaimNumber>" +
      "<pat:ClaimText>FICTIONAL-EMBEDDED-AMENDMENT-CLAIM</pat:ClaimText>" +
      "</pat:Claim></pat:Claims>" +
      "</jppat:WrittenAmendment>" +
      "</jppat:WrittenAmendmentBag>\n";
    const xml = replaceRequired(
      baseXml,
      "</jppat:UnexaminedPatentPublication>",
      `${embeddedAmendment}</jppat:UnexaminedPatentPublication>`,
    );

    const result = parseKohoXml(withXml("A1", xml));

    expectSuccess(result);
    const document = extractedFull(result);
    expect(document.claims.map((claim) => claim.claimNumber)).not.toContain(
      "99",
    );
    expect(document.amendmentContent).toHaveLength(1);
    expect(document.amendmentContent[0].localName).toBe(
      "WrittenAmendmentBag",
    );
    expect(JSON.stringify(document.amendmentContent[0])).toContain(
      "FICTIONAL-EMBEDDED-AMENDMENT-CLAIM",
    );
  });

  it("applicant/name/IPC/FI/claim/paragraphのsource順を保持する", () => {
    const xml = buildFictionalFullPublicationXml("A1", {
      applicants: [
        {
          sequenceNumber: "7",
          partyIdentifier: "FICTIONAL-PARTY-ORDER-1",
          names: [
            { value: "架空順序第一名称", originalLanguageIndicator: true },
            { value: "Fictional Ordered Name One", originalLanguageIndicator: false },
          ],
        },
        {
          sequenceNumber: "9",
          partyIdentifier: "FICTIONAL-PARTY-ORDER-2",
          names: ["架空順序第二名称"],
        },
      ],
      ipc: ["FICTIONAL-IPC-1", "FICTIONAL-IPC-2", "FICTIONAL-IPC-3"],
      fi: ["FICTIONAL-FI-1", "FICTIONAL-FI-2", "FICTIONAL-FI-3"],
      claims: [
        { number: "11", text: "架空順序請求項一" },
        { number: "12", text: "架空順序請求項二" },
        { number: "13", text: "架空順序請求項三" },
      ],
      paragraphs: [
        { number: "0101", text: "架空順序段落一" },
        { number: "0102", text: "架空順序段落二" },
        { number: "0103", text: "架空順序段落三" },
      ],
    });
    const result = parseKohoXml(withXml("A1", xml));

    expectSuccess(result);
    const document = extractedFull(result);
    expect(document.applicants.map((applicant) => applicant.sequenceNumber)).toEqual([
      "7",
      "9",
    ]);
    expect(document.applicants.map((applicant) => applicant.names.map((name) => name.value))).toEqual([
      ["架空順序第一名称", "Fictional Ordered Name One"],
      ["架空順序第二名称"],
    ]);
    expect(document.ipc.map(({ ordinal, role, value }) => ({ ordinal, role, value }))).toEqual([
      { ordinal: 1, role: "main", value: "FICTIONAL-IPC-1" },
      { ordinal: 2, role: "further", value: "FICTIONAL-IPC-2" },
      { ordinal: 3, role: "further", value: "FICTIONAL-IPC-3" },
    ]);
    expect(document.fi.map((item) => item.value)).toEqual([
      "FICTIONAL-FI-1",
      "FICTIONAL-FI-2",
      "FICTIONAL-FI-3",
    ]);
    expect(document.claims.map((claim) => [claim.claimNumber, claim.plainText])).toEqual([
      ["11", "架空順序請求項一"],
      ["12", "架空順序請求項二"],
      ["13", "架空順序請求項三"],
    ]);
    expect(document.description.map((paragraph) => [paragraph.paragraphNumber, paragraph.plainText])).toEqual([
      ["0101", "架空順序段落一"],
      ["0102", "架空順序段落二"],
      ["0103", "架空順序段落三"],
    ]);
  });

  it("mixed text→child→tail順とescaped ST.25文字列の一度だけのdecodeを保持する", () => {
    const xml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0201", text: "架空mixed試験" }],
      mixedContent: { firstParagraph: true },
    });
    const result = parseKohoXml(withXml("A1", xml));

    expectSuccess(result);
    const paragraph = extractedFull(result).description[0];
    expect(paragraph.plainText).toBe(
      "架空mixed試験 架空前部架空強調部架空後部\n" +
        "架空改行後架空図参照架空末尾 <FICTIONAL-ST25-TAG>",
    );
    expect(paragraph.plainText).not.toContain("&lt;");
    expect(paragraph.plainText.match(/<FICTIONAL-ST25-TAG>/g)).toHaveLength(1);
    expect(
      paragraph.content.tokens.map((token) =>
        token.type === "boundary" ? `boundary:${token.boundary}` : token.type,
      ),
    ).toEqual([
      "text",
      "boundary:line_break",
      "text",
      "figure_reference",
      "text",
      "boundary:paragraph",
    ]);
  });

  it("image/table/math/chemical参照を本文位置の順でtoken化する", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0301", text: "FICTIONAL-REFERENCE-INSERTION" }],
    });
    const referenceNodes = [
      '<com:Image><com:FileName>FICTIONAL-image.tif</com:FileName></com:Image>',
      '<com:Table><com:TableImage><com:FileName>FICTIONAL-table.tif</com:FileName></com:TableImage></com:Table>',
      '<com:Math><com:Image><com:FileName>FICTIONAL-math.tif</com:FileName></com:Image></com:Math>',
      '<com:ChemicalFormulae><com:Image><com:FileName>FICTIONAL-chemical.tif</com:FileName></com:Image></com:ChemicalFormulae>',
    ].join("");
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-REFERENCE-INSERTION",
      `架空参照前${referenceNodes}架空参照後`,
    );
    const result = parseKohoXml(withXml("A1", xml));

    expectSuccess(result);
    const paragraph = extractedFull(result).description[0];
    expect(paragraph.content.tokens.map((token) => token.type)).toEqual([
      "text",
      "image_reference",
      "table_reference",
      "math_reference",
      "chemical_formula_reference",
      "text",
      "boundary",
    ]);
    expect(paragraph.plainText).toBe(
      "架空参照前" +
        "[image:FICTIONAL-image.tif]" +
        "[table:FICTIONAL-table.tif]" +
        "[math:FICTIONAL-math.tif]" +
        "[chemical-formula:FICTIONAL-chemical.tif]" +
        "架空参照後",
    );
  });

  it("未知inlineを内容ごと保持しreview_requiredにする", () => {
    const baseXml = buildFictionalFullPublicationXml("A1", {
      paragraphs: [{ number: "0401", text: "FICTIONAL-UNKNOWN-INSERTION" }],
    });
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-UNKNOWN-INSERTION",
      "架空未知前<jpcom:FictionalUnknownInline>架空未知子前<com:B>架空未知強調</com:B>架空未知子後</jpcom:FictionalUnknownInline>架空未知後",
    );
    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(result.kind).toBe("A1");
    expect(issuesFor(result, "unknown_inline_element")).toHaveLength(1);
    expect(issuesFor(result, "unknown_inline_element")[0].field).toContain(
      "/FictionalUnknownInline[1]",
    );
    const paragraph = extractedFull(result).description[0];
    expect(paragraph.plainText).toBe(
      "架空未知前架空未知子前架空未知強調架空未知子後架空未知後",
    );
    const unknown = paragraph.content.tokens.find(
      (token) => token.type === "unknown_inline_element",
    );
    expect(unknown).toEqual(
      expect.objectContaining({
        type: "unknown_inline_element",
        namespaceUri:
          "http://www.jpo.go.jp/standards/XMLSchema/ST96/JPCommon",
        localName: "FictionalUnknownInline",
        plainText: "架空未知子前架空未知強調架空未知子後",
      }),
    );
  });
});

describe("parseKohoXml identity cross-checks", () => {
  it("rootとdirectory区分の不一致ではrecordを確定しない", () => {
    const xml = buildFictionalFullPublicationXml("A1");
    const result = parseKohoXml(
      withXml("A1", xml, { entryPath: fictionalPrimaryEntryPath("P1") }),
    );

    expect(result.status).toBe("review_required");
    expect(result.kind).toBe("A1");
    expect(issuesFor(result, "root_path_mismatch")).toEqual([
      expect.objectContaining({ field: "entryPath", status: "review_required" }),
    ]);
    if (!("identityConfirmed" in result) || !("candidate" in result)) {
      throw new Error("expected an unconfirmed full-publication candidate");
    }
    expect(result.identityConfirmed).toBe(false);
    expect(result.candidate?.kind).toBe("A1");
  });

  it("kind hint不一致をkind_mismatchとして候補隔離する", () => {
    const xml = buildFictionalFullPublicationXml("A1");
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        indexHint: {
          kindCode: "B1",
          publicationNumber: "2099000001",
          publicationDate: "20990111",
        },
      }),
    );

    expect(result.status).toBe("review_required");
    expect(issuesFor(result, "kind_mismatch")).toEqual([
      expect.objectContaining({ field: "indexHint.kindCode" }),
    ]);
    if (!("identityConfirmed" in result)) {
      throw new Error("expected identity confirmation metadata");
    }
    expect(result.identityConfirmed).toBe(false);
    expect(extractedFull(result).publicationNumber.value).toBe("2099000001");
  });

  it("folderとindex hintの公開番号不一致を別々に記録する", () => {
    const xml = buildFictionalFullPublicationXml("A1");
    const result = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml,
        entryPath:
          "DOCUMENT/P_A1/999900/999990/2099000999/2099000999.xml",
        indexHint: {
          kindCode: "A",
          publicationNumber: "2099000888",
          publicationDate: "20990111",
        },
      }),
    );

    expect(result.status).toBe("review_required");
    expect(issuesFor(result, "publication_number_mismatch").map((item) => item.field)).toEqual([
      "publicationNumber",
      "indexHint.publicationNumber",
    ]);
    if (!("identityConfirmed" in result)) {
      throw new Error("expected identity confirmation metadata");
    }
    expect(result.identityConfirmed).toBe(false);
  });

  it("期待外schema basenameをschema_mismatchとして候補隔離する", () => {
    const xml = buildFictionalFullPublicationXml("A1", {
      schemaBasename: "JPFictionalWrongPublication_V1_0.xsd",
    });
    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(result.source.schemaBasename).toBe(
      "JPFictionalWrongPublication_V1_0.xsd",
    );
    expect(issuesFor(result, "schema_mismatch")).toEqual([
      expect.objectContaining({ field: "xsi:schemaLocation" }),
    ]);
    if (!("identityConfirmed" in result)) {
      throw new Error("expected identity confirmation metadata");
    }
    expect(result.identityConfirmed).toBe(false);
  });
});

describe("parseKohoXml required and kind-specific fields", () => {
  const missingFieldCases: Array<[
    string,
    FictionalFullPublicationXmlOptions,
    string,
  ]> = [
    ["publication number", { publicationNumber: null }, "publicationNumber"],
    ["application number", { applicationNumber: null }, "applicationNumber"],
    ["application date", { applicationDate: null }, "applicationDate"],
    ["publication date", { publicationDate: null }, "publicationDate"],
    ["invention title", { inventionTitle: null }, "inventionTitle"],
    ["description", { paragraphs: null }, "description"],
  ];

  it.each(missingFieldCases)("必須%s欠損をfailedにする", (_label, options, field) => {
    const xml = buildFictionalFullPublicationXml("A1", options);
    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("failed");
    expect(result.entryType).toBe("full_publication");
    expect(result.kind).toBe("A1");
    expect(issuesFor(result, "required_field_missing").some((item) => item.field === field)).toBe(true);
  });

  it("Claims containerが0件ならclaims_missingでfailedにする", () => {
    const xml = buildFictionalFullPublicationXml("A1", { claims: [] });
    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("failed");
    expect(issuesFor(result, "claims_missing")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("Applicantは存在しても有効名称0件ならapplicant_name_missingでfailedにする", () => {
    const xml = buildFictionalFullPublicationXml("A1", {
      applicants: [
        {
          sequenceNumber: "1",
          partyIdentifier: "FICTIONAL-NAMELESS-PARTY",
          names: [],
        },
      ],
    });
    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("failed");
    expect(issuesFor(result, "applicant_name_missing")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("存在しない暦日をinvalid_dateでfailedにする", () => {
    const xml = buildFictionalFullPublicationXml("A1", {
      applicationDate: "2099-02-30",
    });
    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("failed");
    expect(issuesFor(result, "invalid_date")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(issuesFor(result, "invalid_date")[0].field).toContain("FilingDate");
  });

  it("multiple IPC main classifications are preserved for review", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "</pat:MainClassification>",
      "</pat:MainClassification>" +
        "<pat:MainClassification>FICTIONAL-IPC-SECOND-MAIN</pat:MainClassification>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expect(
      extractedFull(result).ipc.filter((classification) =>
        classification.role === "main",
      ).map((classification) => classification.value),
    ).toEqual(["FICTIONAL-IPC-MAIN", "FICTIONAL-IPC-SECOND-MAIN"]);
  });

  it("an FI container without a main classification requires review", () => {
    let xml = buildFictionalFullPublicationXml("A1");
    xml = replaceRequired(
      xml,
      "<jppat:MainNationalClassification>",
      "<jppat:FurtherNationalClassification>",
    );
    xml = replaceRequired(
      xml,
      "</jppat:MainNationalClassification>",
      "</jppat:FurtherNationalClassification>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expect(extractedFull(result).fi.every((item) => item.role === "further")).toBe(
      true,
    );
  });

  it("duplicate FI text values are retained without confirming them silently", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "</pat:PatentClassificationText>",
      "</pat:PatentClassificationText>" +
        "<pat:PatentClassificationText>FICTIONAL-FI-DUPLICATE-TEXT</pat:PatentClassificationText>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expect(extractedFull(result).fi[0].values).toEqual([
      "FICTIONAL-FI-MAIN",
      "FICTIONAL-FI-DUPLICATE-TEXT",
    ]);
  });

  it("classification scalar child structure is preserved for review", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "FICTIONAL-IPC-MAIN",
      '<evil:FictionalClassification xmlns:evil="urn:fictional-evil">' +
        "FICTIONAL-IPC-MAIN</evil:FictionalClassification>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_inline_element");
    const ipc = extractedFull(result).ipc[0];
    expect(ipc.value).toBe("FICTIONAL-IPC-MAIN");
    expect(JSON.stringify(ipc.sources[0].sourceElement)).toContain(
      "FictionalClassification",
    );
  });

  it("duplicate applicant party identifiers are all retained for review", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "</com:PartyIdentifier>",
      "</com:PartyIdentifier>" +
        "<com:PartyIdentifier>FICTIONAL-PARTY-DUPLICATE</com:PartyIdentifier>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("cardinality_mismatch");
    expect(
      extractedFull(result).applicants[0].partyIdentifiers.map(
        (identifier) => identifier.value,
      ),
    ).toEqual(["FICTIONAL-PARTY-0001", "FICTIONAL-PARTY-DUPLICATE"]);
  });

  it("claim-number child media is preserved and its target is checked", () => {
    const baseXml = buildFictionalFullPublicationXml("A1");
    const xml = replaceRequired(
      baseXml,
      "<pat:ClaimNumber>1</pat:ClaimNumber>",
      "<pat:ClaimNumber><com:Image>" +
        "<com:FileName>../FICTIONAL-CLAIM-NUMBER.tif</com:FileName>" +
        "</com:Image></pat:ClaimNumber>",
    );

    const result = parseKohoXml(withXml("A1", xml));

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_inline_element");
    expect(issueCodes(result)).toContain("unsafe_reference_target");
    const document = extractedFull(result);
    expect(document.claims[0].claimNumber).toBe(
      "../FICTIONAL-CLAIM-NUMBER.tif",
    );
    expect(JSON.stringify(document.claims[0].claimNumberSource?.sourceElement)).toContain(
      "Image",
    );
    expect(document.references).toEqual([
      expect.objectContaining({
        kind: "inline_image",
        reference: expect.objectContaining({ resolution: "rejected" }),
      }),
    ]);
  });

  it.each(["A1", "P1", "B1"] as const)(
    "%sのabstract欠損をreview_requiredとして抽出済みdataを保持する",
    (kind) => {
      const xml = buildFictionalFullPublicationXml(kind, {
        includeAbstract: false,
      });
      const result = parseKohoXml(withXml(kind, xml));

      expect(result.status).toBe("review_required");
      expect(result.kind).toBe(kind);
      expect(issuesFor(result, "optional_abstract_missing")).toEqual([
        expect.objectContaining({ field: "abstract", status: "review_required" }),
      ]);
      const document = extractedFull(result);
      expect(document.abstract).toBeNull();
      if (!("identityConfirmed" in result)) {
        throw new Error("expected identity confirmation metadata");
      }
      expect(result.identityConfirmed).toBe(true);
    },
  );
});

describe("parseKohoXml deterministic output", () => {
  it("同一の架空入力からdeep equalな結果を返す", () => {
    const input = createFictionalKohoInput("P5", {
      xml: buildFictionalAmendmentXml("P5", { mixedContent: true }),
    });

    const first = parseKohoXml(input);
    const second = parseKohoXml(input);

    expect(second).toEqual(first);
    expect(issueCodes(second)).toEqual(issueCodes(first));
  });
});
