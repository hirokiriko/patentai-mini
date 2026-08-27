import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMinimalFictionalPackage,
  FICTIONAL_PACKAGE_LIMITS,
} from "../koho-package/__fixtures__/fictional-package";
import { parseKohoPackage } from "../koho-package";
import type {
  KohoPackageCountSummary,
  KohoPackageIssue,
  KohoPackageParseResult,
  KohoPackageType,
  KohoPackageXmlResult,
} from "../koho-package";
import {
  buildFictionalFullPublicationXml,
  createFictionalKohoInput,
} from "../koho-xml/__fixtures__/fictional-koho";
import {
  parseKohoXml,
  type KohoDocumentKind,
  type KohoFullPublicationResult,
  type KohoXmlParseResult,
} from "../koho-xml";
import { buildKohoImportPlan } from "./builder";
import {
  KohoImportPlanValidationError,
  type BuildKohoImportPlanInput,
} from "./types";

const SOURCE_SHA256 = "1".repeat(64);
type FictionalFullKind = Extract<KohoDocumentKind, "A1" | "P1" | "B1" | "B2">;

const MINIMAL_PACKAGE_GOLDEN = {
  JPA: {
    countsJson: "d5b72ec4fc93a159337e0cc58661dd82901e43cda04d1829b1857e563538a621",
    issuesJson: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    applicantsJson: "3a6e5f7ed72e89062ed9bfb95228a7fc4144dae834b358fc35e8ee13c54ae6d2",
    ipcJson: "cbf83532e65a7c57fa45c9ebf6408aab6bbd1a133b84928b98accc77c928d978",
    fiJson: "f1936ef9e40781ac501c308690b616ffeeed3f29f2e3b22083ed03d1bd1c1284",
    parseIssuesJson: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    sourceMetadataJson:
      "ebec27c6d74d6f705cbaa3eb67fc8a9b14f2aa1039189dfe4fa9446467a26610",
    contentSha256: "a0fa285247653575094acccbd629f20339a7eb4bf946e9e26d82252660c4fc3c",
  },
  JPB: {
    countsJson: "20921336df755a72ecd80ad957a4c38b37accc70bd94196ac30dbc463211c329",
    issuesJson: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    applicantsJson: "3a6e5f7ed72e89062ed9bfb95228a7fc4144dae834b358fc35e8ee13c54ae6d2",
    ipcJson: "cbf83532e65a7c57fa45c9ebf6408aab6bbd1a133b84928b98accc77c928d978",
    fiJson: "f1936ef9e40781ac501c308690b616ffeeed3f29f2e3b22083ed03d1bd1c1284",
    parseIssuesJson: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    sourceMetadataJson:
      "ebd485a251b3c8d436068c174b750ab1b35d56a371dae835facf8865ba815746",
    contentSha256: "08501ddec37b0c5e8a8b07a712601aa72bfeedcacffce604a862f852800a5b5d",
  },
} as const;

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function emptyRoleCounts() {
  return {
    directory: 0,
    xml: 0,
    csv: 0,
    schema: 0,
    image: 0,
    other: 0,
  };
}

function emptySectionCounts() {
  return {
    primaryXmlCandidates: 0,
    finalXmlResults: 0,
    confirmedFullPublications: 0,
    confirmedAmendments: 0,
    documentFolders: 0,
    contents1Records: 0,
    contents2Records: 0,
    attachmentCount: 0,
    roleCounts: emptyRoleCounts(),
  };
}

function makeCounts(
  overrides: Partial<KohoPackageCountSummary> = {},
): KohoPackageCountSummary {
  return {
    primaryXmlCandidates: 0,
    finalXmlResults: 0,
    confirmedFullPublications: 0,
    confirmedAmendments: 0,
    nestedXmlCandidates: 0,
    documentFolders: 0,
    documentListRecords: 0,
    roleCounts: emptyRoleCounts(),
    bySection: {
      P_A1: emptySectionCounts(),
      P_A5: emptySectionCounts(),
      P_P1: emptySectionCounts(),
      P_P5: emptySectionCounts(),
      P_B1: emptySectionCounts(),
    },
    ...overrides,
  };
}

function attach(
  entryId: number,
  result: KohoXmlParseResult,
): KohoPackageXmlResult {
  return {
    entryId,
    normalizedPath: result.source.normalizedEntryPath,
    result,
  };
}

function makePackageResult(
  packageType: KohoPackageType,
  primaryXmlResults: KohoPackageXmlResult[],
  options: {
    status?: KohoPackageParseResult["status"];
    counts?: Partial<KohoPackageCountSummary>;
    issues?: KohoPackageIssue[];
  } = {},
): KohoPackageParseResult {
  const confirmedFullPublications = primaryXmlResults.filter(
    ({ result }) =>
      result.entryType === "full_publication" &&
      "identityConfirmed" in result &&
      result.identityConfirmed === true,
  ).length;
  return {
    status: options.status ?? "success",
    packageType,
    zipSummary: null,
    manifest: [],
    csvResults: [],
    primaryXmlResults,
    counts: makeCounts({
      primaryXmlCandidates: primaryXmlResults.length,
      finalXmlResults: primaryXmlResults.length,
      confirmedFullPublications,
      ...options.counts,
    }),
    issues: options.issues ?? [],
  };
}

function parseKind(kind: KohoDocumentKind): KohoXmlParseResult {
  return parseKohoXml(createFictionalKohoInput(kind));
}

function parseFullPublication(
  kind: FictionalFullKind,
  xmlOptions: Parameters<typeof buildFictionalFullPublicationXml>[1] = {},
): Extract<KohoFullPublicationResult, { identityConfirmed: true }> {
  const result = parseKohoXml(
    createFictionalKohoInput(kind, {
      xml: buildFictionalFullPublicationXml(kind, xmlOptions),
    }),
  );
  if (
    result.entryType !== "full_publication" ||
    !("identityConfirmed" in result) ||
    result.identityConfirmed !== true ||
    !("document" in result) ||
    result.document === null
  ) {
    throw new Error("fictional fixture did not produce a confirmed publication");
  }
  return result;
}

function build(packageResult: KohoPackageParseResult) {
  return buildKohoImportPlan({ packageResult, sourceSha256: SOURCE_SHA256 });
}

describe("buildKohoImportPlan", () => {
  it.each([
    ["JPA", "A1"],
    ["JPB", "B1"],
  ] as const)(
    "projects a confirmed %s %s full publication",
    (packageType, kind) => {
      const result = parseFullPublication(kind);
      const plan = build(makePackageResult(packageType, [attach(1, result)]));

      expect(plan).toMatchObject({
        packageType,
        sourceSha256: SOURCE_SHA256,
        packageStatus: "success",
        documentCount: 1,
      });
      expect(plan.documents[0]).toMatchObject({
        normalizedEntryPath: result.source.normalizedEntryPath,
        parseStatus: "success",
        kind,
        publicationNumber: result.document.publicationNumber.value,
        applicationNumber: result.document.applicationNumber.value,
        publicationDate: result.document.publicationDate.value,
      });
    },
  );

  it("keeps a review-required identity-confirmed publication and its safe issues", () => {
    const result = parseFullPublication("A1", { abstract: null });
    expect(result.status).toBe("review_required");

    const plan = build(
      makePackageResult("JPA", [attach(1, result)], {
        status: "review_required",
      }),
    );
    const issues = JSON.parse(plan.documents[0].parseIssuesJson) as Array<
      Record<string, unknown>
    >;

    expect(plan.documents[0].parseStatus).toBe("review_required");
    expect(issues).toContainEqual({
      code: "optional_abstract_missing",
      status: "review_required",
      field: "abstract",
    });
    expect(issues.every((issue) => !("message" in issue))).toBe(true);
  });

  it("excludes amendments, nested, unconfirmed, unsupported and failed XML results", () => {
    const confirmed = parseFullPublication("A1");
    const nested: KohoXmlParseResult = {
      status: "success",
      entryType: "nested_st26",
      kind: null,
      identityConfirmed: true,
      source: { ...confirmed.source },
      issues: [],
      nestedSt26: { dtdVersion: "V1_3", contentParsed: false },
    };
    const unconfirmed = parseKohoXml(
      createFictionalKohoInput("A1", { indexHint: null }),
    );
    const unsupported = parseKohoXml(
      createFictionalKohoInput("A1", {
        xml: buildFictionalFullPublicationXml("A1").replaceAll(
          "UnexaminedPatentPublication",
          "FictionalUnknownPublication",
        ),
      }),
    );
    const failed = parseKohoXml(
      createFictionalKohoInput("A1", { xml: "<FICTIONAL-BROKEN" }),
    );
    const a5 = parseKind("A5");
    const p5 = parseKind("P5");
    const plan = build(
      makePackageResult(
        "JPA",
        [confirmed, unconfirmed, unsupported, failed, a5, p5, nested].map(
          (result, index) => attach(index + 1, result),
        ),
        {
          status: "review_required",
          counts: { confirmedAmendments: 2, nestedXmlCandidates: 1 },
        },
      ),
    );

    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0].kind).toBe("A1");
    expect(plan.amendmentCount).toBe(2);
    expect(plan.nestedSt26Count).toBe(1);
  });

  it("retains deterministic amendment, nested and issue aggregates without raw details", () => {
    const result = parseFullPublication("A1", { abstract: null });
    const packageIssue: KohoPackageIssue = {
      code: "contents_file_missing",
      status: "review_required",
      message: "FICTIONAL-PACKAGE-MESSAGE-MUST-NOT-PERSIST",
      normalizedPath: "FICTIONAL/PATH-MUST-NOT-PERSIST",
      section: "P_A1",
    };
    const plan = build(
      makePackageResult("JPA", [attach(1, result)], {
        status: "review_required",
        counts: { confirmedAmendments: 4, nestedXmlCandidates: 3 },
        issues: [
          packageIssue,
          { ...packageIssue },
          { ...packageIssue, section: "P_A5" },
          { ...packageIssue, status: "failed", section: "P_A5" },
          {
            code: "abstract_count_mismatch",
            status: "review_required",
            message: "FICTIONAL-SECOND-MESSAGE-MUST-NOT-PERSIST",
            section: "P_P1",
          },
        ],
      }),
    );
    const issues = JSON.parse(plan.issuesJson) as Array<Record<string, unknown>>;

    expect(plan.amendmentCount).toBe(4);
    expect(plan.nestedSt26Count).toBe(3);
    expect(issues).toEqual([
      {
        source: "package",
        code: "abstract_count_mismatch",
        status: "review_required",
        kind: null,
        section: "P_P1",
        count: 1,
      },
      {
        source: "package",
        code: "contents_file_missing",
        status: "failed",
        kind: null,
        section: "P_A5",
        count: 1,
      },
      {
        source: "package",
        code: "contents_file_missing",
        status: "review_required",
        kind: null,
        section: "P_A1",
        count: 2,
      },
      {
        source: "package",
        code: "contents_file_missing",
        status: "review_required",
        kind: null,
        section: "P_A5",
        count: 1,
      },
      {
        source: "xml",
        code: "optional_abstract_missing",
        status: "review_required",
        kind: "A1",
        section: null,
        count: 1,
      },
    ]);
    expect(plan.issuesJson).not.toContain("MESSAGE-MUST-NOT-PERSIST");
    expect(plan.issuesJson).not.toContain("PATH-MUST-NOT-PERSIST");
  });

  it.each([
    "A".repeat(64),
    ` ${"1".repeat(64)}`,
    "1".repeat(63),
  ])("rejects invalid source hash before touching package source", (sourceSha256) => {
    let packageTouched = false;
    const input = {
      sourceSha256,
      get packageResult() {
        packageTouched = true;
        throw new Error("package source must not be touched");
      },
    } as unknown as BuildKohoImportPlanInput;

    expect(() => buildKohoImportPlan(input)).toThrowError(
      KohoImportPlanValidationError,
    );
    try {
      buildKohoImportPlan(input);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_source_sha256" });
    }
    expect(packageTouched).toBe(false);
  });

  it("rejects duplicate normalized document paths instead of overwriting", () => {
    const result = parseFullPublication("A1");
    const packageResult = makePackageResult("JPA", [
      attach(9, result),
      attach(2, result),
    ]);

    expect(() => build(packageResult)).toThrowError(
      expect.objectContaining({ code: "duplicate_normalized_entry_path" }),
    );
  });

  it("preserves source array order, sorts plans, fixes JSON keys and hashes canonical payload", () => {
    const a1 = parseFullPublication("A1", {
      inventionTitle: "架空の決定的投影装置",
      abstract: "架空の決定的投影要約",
      applicants: [
        {
          sequenceNumber: "2",
          names: [
            { value: "架空第二出願人", originalLanguageIndicator: false },
            { value: "FICTIONAL SECOND APPLICANT", originalLanguageIndicator: true },
          ],
        },
        { sequenceNumber: "1", names: ["架空第一出願人"] },
      ],
      ipc: ["G06F 99/99", "H04L 99/99"],
      fi: ["G06F 99/99 999", "H04L 99/99 999"],
      claims: [
        { number: "2", text: "架空請求項の第二記載" },
        { number: "1", text: "架空請求項の第一記載" },
      ],
      paragraphs: [
        { number: "0099", text: "FICTIONAL-DESCRIPTION-MUST-NOT-PERSIST" },
      ],
    });
    (a1.document.references as unknown[]).push({
      marker: "FICTIONAL-REFERENCE-MUST-NOT-PERSIST",
    });
    (a1.document.amendmentContent as unknown[]).push({
      marker: "FICTIONAL-SNAPSHOT-MUST-NOT-PERSIST",
    });
    const p1 = parseFullPublication("P1");
    const packageResult = makePackageResult("JPA", [attach(20, p1), attach(10, a1)]);
    packageResult.csvResults = [
      { marker: "FICTIONAL-RAW-CSV-MUST-NOT-PERSIST" },
    ] as unknown as KohoPackageParseResult["csvResults"];

    const first = build(packageResult);
    const second = build(packageResult);
    expect(second).toEqual(first);
    expect(first.documents.map((document) => document.normalizedEntryPath)).toEqual(
      [a1.source.normalizedEntryPath, p1.source.normalizedEntryPath].sort(),
    );

    const projected = first.documents.find((document) => document.kind === "A1")!;
    expect(projected.inventionTitle).toBe("架空の決定的投影装置");
    expect(projected.abstractText).toBe("架空の決定的投影要約");
    expect(projected.claimsText).toBe(
      a1.document.claims.map((claim) => claim.plainText).join("\n\n"),
    );

    const applicants = JSON.parse(projected.applicantsJson) as Array<Record<string, unknown>>;
    const ipc = JSON.parse(projected.ipcJson) as Array<Record<string, unknown>>;
    const fi = JSON.parse(projected.fiJson) as Array<Record<string, unknown>>;
    const sourceMetadata = JSON.parse(projected.sourceMetadataJson) as Record<
      string,
      unknown
    >;
    expect(applicants.map((applicant) => applicant.ordinal)).toEqual(
      a1.document.applicants.map((applicant) => applicant.ordinal),
    );
    expect(Object.keys(applicants[0])).toEqual([
      "ordinal",
      "sequenceNumber",
      "names",
    ]);
    expect(Object.keys((applicants[0].names as Array<object>)[0])).toEqual([
      "value",
      "sourceValue",
      "originalLanguageIndicator",
    ]);
    expect(ipc).toEqual(
      a1.document.ipc.map(({ ordinal, role, value, sourceValue }) => ({
        ordinal,
        role,
        value,
        sourceValue,
      })),
    );
    expect(fi).toEqual(
      a1.document.fi.map(({ ordinal, role, value, sourceValue }) => ({
        ordinal,
        role,
        value,
        sourceValue,
      })),
    );
    expect(sourceMetadata).toEqual({
      normalizedEntryPath: a1.document.source.normalizedEntryPath,
      rootLocalName: a1.document.source.rootLocalName,
      rootNamespaceUri: a1.document.source.rootNamespaceUri,
      schemaBasename: a1.document.source.schemaBasename,
      st96Version: a1.document.source.st96Version,
      ipoVersion: a1.document.source.ipoVersion,
      languageCode: a1.document.source.languageCode,
      xsdValidation: a1.document.source.xsdValidation,
    });

    const { contentSha256, ...payload } = projected;
    expect(contentSha256).toBe(
      createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
    );
    expect(contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toMatch(
      /DESCRIPTION-MUST-NOT-PERSIST|REFERENCE-MUST-NOT-PERSIST|SNAPSHOT-MUST-NOT-PERSIST|RAW-CSV-MUST-NOT-PERSIST/,
    );
  });

  it("projects nullable abstract and registration fields by publication kind", () => {
    const a1 = build(makePackageResult("JPA", [attach(1, parseFullPublication("A1"))]))
      .documents[0];
    const b2 = build(makePackageResult("JPB", [attach(1, parseFullPublication("B2"))]))
      .documents[0];

    expect(a1).toMatchObject({
      abstractText: expect.any(String),
      registrationNumber: null,
      registrationDate: null,
    });
    expect(b2).toMatchObject({
      abstractText: null,
      registrationNumber: expect.any(String),
      registrationDate: expect.any(String),
    });
  });

  it("returns a deterministic run-only plan when there are no documents", () => {
    const packageResult = makePackageResult("JPA", [], {
      status: "review_required",
      counts: { confirmedAmendments: 1, nestedXmlCandidates: 2 },
    });
    const plan = build(packageResult);

    expect(plan).toMatchObject({
      packageStatus: "review_required",
      documentCount: 0,
      amendmentCount: 1,
      nestedSt26Count: 2,
      documents: [],
      issuesJson: "[]",
    });
    expect(JSON.parse(plan.countsJson)).toMatchObject({
      confirmedAmendments: 1,
      nestedXmlCandidates: 2,
    });
  });

  it("rejects unknown package values and unsafe paths at the builder boundary", () => {
    const result = parseFullPublication("A1");
    const unknownPackage = makePackageResult("JPA", [attach(1, result)]) as unknown as {
      packageType: string;
    };
    unknownPackage.packageType = "JPC";
    expect(() => build(unknownPackage as unknown as KohoPackageParseResult)).toThrowError(
      expect.objectContaining({ code: "invalid_package_type" }),
    );

    const unsafePath = makePackageResult("JPA", [attach(1, result)]);
    unsafePath.primaryXmlResults[0].normalizedPath = "../FICTIONAL.xml";
    expect(() => build(unsafePath)).toThrowError(
      expect.objectContaining({ code: "invalid_normalized_entry_path" }),
    );
  });
});

describe("buildKohoImportPlan golden compatibility", () => {
  it.each(["JPA", "JPB"] as const)(
    "keeps the fictional minimal %s package JSON bytes and digest stable",
    async (packageType) => {
      const packageResult = await parseKohoPackage({
        packageType,
        source: {
          type: "buffer",
          bytes: buildMinimalFictionalPackage(packageType),
          sourceName: `fictional-${packageType.toLowerCase()}-package.zip`,
        },
        limits: FICTIONAL_PACKAGE_LIMITS,
      });
      const first = buildKohoImportPlan({
        packageResult,
        sourceSha256: SOURCE_SHA256,
      });
      const second = buildKohoImportPlan({
        packageResult,
        sourceSha256: SOURCE_SHA256,
      });

      expect(second).toEqual(first);
      expect(first).toMatchObject({
        packageType,
        packageStatus: "success",
        documentCount: 1,
        amendmentCount: 0,
        nestedSt26Count: 0,
      });
      expect(first.documents).toHaveLength(1);

      const document = first.documents[0];
      expect({
        countsJson: sha256Text(first.countsJson),
        issuesJson: sha256Text(first.issuesJson),
        applicantsJson: sha256Text(document.applicantsJson),
        ipcJson: sha256Text(document.ipcJson),
        fiJson: sha256Text(document.fiJson),
        parseIssuesJson: sha256Text(document.parseIssuesJson),
        sourceMetadataJson: sha256Text(document.sourceMetadataJson),
        contentSha256: document.contentSha256,
      }).toEqual(MINIMAL_PACKAGE_GOLDEN[packageType]);
    },
  );
});
