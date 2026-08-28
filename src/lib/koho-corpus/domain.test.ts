import { describe, expect, it } from "vitest";

import {
  buildKohoCorpusAttachPlan,
  buildKohoCorpusSnapshot,
  parseKohoCorpusSearchParams,
  searchKohoCorpusDocuments,
  validateKohoCorpusAttachRequest,
} from "./domain";

const SOURCE_SHA_1 = "a".repeat(64);
const SOURCE_SHA_2 = "b".repeat(64);
const CONTENT_SHA_1 = "c".repeat(64);
const CONTENT_SHA_2 = "d".repeat(64);

interface CorpusDocumentFixture {
  documentId: number;
  importId: number;
  packageType: "JPA" | "JPB";
  sourceSha256: string;
  normalizedEntryPath: string;
  parseStatus: "success" | "review_required";
  kind: "A1" | "P1" | "B1" | "B2";
  publicationNumber: string;
  applicationNumber: string;
  publicationDate: string;
  registrationNumber: string | null;
  registrationDate: string | null;
  inventionTitle: string;
  abstractText: string | null;
  claimsText: string;
  applicantsJson: string;
  ipcJson: string;
  fiJson: string;
  parseIssuesJson: string;
  sourceMetadataJson: string;
  contentSha256: string;
  rawXml: string;
  rawCsv: string;
  description: string;
  reference: string;
  image: string;
  attachment: string;
  [key: string]: unknown;
}

function fictionalCorpusDocument(
  overrides: Partial<CorpusDocumentFixture> = {},
): CorpusDocumentFixture {
  const normalizedEntryPath =
    typeof overrides.normalizedEntryPath === "string"
      ? overrides.normalizedEntryPath
      : "normalized/P_A1/fictional-document.xml";

  return {
    documentId: 11,
    importId: 101,
    packageType: "JPA",
    sourceSha256: SOURCE_SHA_1,
    normalizedEntryPath,
    parseStatus: "success",
    kind: "A1",
    publicationNumber: "JP2099-000001A",
    applicationNumber: "JP2098-000001",
    publicationDate: "20990102",
    registrationNumber: null,
    registrationDate: null,
    inventionTitle: "架空の光学センサー",
    abstractText: "架空の要約です。",
    claimsText: "【請求項１】架空のセンサー。",
    applicantsJson: JSON.stringify([
      {
        ordinal: 0,
        sequenceNumber: "1",
        names: [
          {
            value: "FICTIONAL-APPLICANT-SENTINEL",
            sourceValue: "FICTIONAL-APPLICANT-SENTINEL",
            originalLanguageIndicator: false,
          },
        ],
      },
    ]),
    ipcJson: JSON.stringify([
      {
        ordinal: 0,
        role: "main",
        value: "FICTIONAL-IPC-SENTINEL",
        sourceValue: "FICTIONAL-IPC-SENTINEL",
      },
    ]),
    fiJson: JSON.stringify([
      {
        ordinal: 0,
        role: "main",
        value: "FICTIONAL-FI-SENTINEL",
        sourceValue: "FICTIONAL-FI-SENTINEL",
      },
    ]),
    parseIssuesJson: JSON.stringify([
      {
        code: "FICTIONAL-PARSE-ISSUE-SENTINEL",
        message: "FICTIONAL-PARSE-ISSUE-MESSAGE-SENTINEL",
      },
    ]),
    sourceMetadataJson: JSON.stringify({
      normalizedEntryPath,
      rootLocalName: "FICTIONAL-ROOT-SENTINEL",
      rootNamespaceUri: "urn:fictional:st96",
      schemaBasename: "fictional.xsd",
      st96Version: "9.9",
      ipoVersion: "fictional",
      languageCode: "ja",
      xsdValidation: "not_performed",
    }),
    contentSha256: CONTENT_SHA_1,
    rawXml: "<FICTIONAL-RAW-XML-SENTINEL />",
    rawCsv: "FICTIONAL-RAW-CSV-SENTINEL",
    description: "FICTIONAL-DESCRIPTION-SENTINEL",
    reference: "FICTIONAL-REFERENCE-SENTINEL",
    image: "FICTIONAL-IMAGE-SENTINEL",
    attachment: "FICTIONAL-ATTACHMENT-SENTINEL",
    ...overrides,
  };
}

function existingPriorArt(
  docId: number,
  snapshot: ReturnType<typeof buildKohoCorpusSnapshot>,
  overrides: Record<string, unknown> = {},
) {
  return {
    docId,
    ...snapshot,
    ...overrides,
  };
}

function expectDomainCode(run: () => unknown, code: string) {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

describe("koho corpus search input", () => {
  it("trims q and applies the default limit", () => {
    const params = new URLSearchParams({ q: "  JP2099-000001A  " });

    expect(parseKohoCorpusSearchParams(params)).toEqual({
      query: "JP2099-000001A",
      limit: 20,
    });
  });

  it.each([
    ["1", 1],
    ["50", 50],
    ["01", 1],
  ])("accepts ASCII decimal limit %s", (raw, expected) => {
    const params = new URLSearchParams({ q: "架空", limit: raw });

    expect(parseKohoCorpusSearchParams(params)).toEqual({
      query: "架空",
      limit: expected,
    });
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    const accepted = new URLSearchParams({ q: "😀😀" });
    const tooLong = new URLSearchParams({ q: "😀".repeat(101) });

    expect(parseKohoCorpusSearchParams(accepted).query).toBe("😀😀");
    expectDomainCode(
      () => parseKohoCorpusSearchParams(tooLong),
      "invalid_query",
    );
  });

  it.each([undefined, "", "   ", "a", "😀", "あ".repeat(101)])(
    "rejects a missing or out-of-range q: %s",
    (query) => {
      const params = new URLSearchParams();
      if (query !== undefined) params.set("q", query);

      expectDomainCode(
        () => parseKohoCorpusSearchParams(params),
        "invalid_query",
      );
    },
  );

  it.each([
    "0",
    "51",
    "1.5",
    "+1",
    "-1",
    " 1",
    "1 ",
    "１",
    "NaN",
    "Infinity",
    "one",
  ])("rejects invalid limit %s", (limit) => {
    const params = new URLSearchParams({ q: "架空", limit });

    expectDomainCode(
      () => parseKohoCorpusSearchParams(params),
      "invalid_limit",
    );
  });

  it("rejects duplicate limit parameters", () => {
    const params = new URLSearchParams({ q: "架空" });
    params.append("limit", "1");
    params.append("limit", "2");

    expectDomainCode(
      () => parseKohoCorpusSearchParams(params),
      "invalid_limit",
    );
  });

  it("rejects duplicate q parameters", () => {
    const params = new URLSearchParams();
    params.append("q", "架空");
    params.append("q", "公報");

    expectDomainCode(
      () => parseKohoCorpusSearchParams(params),
      "invalid_query",
    );
  });
});

describe("koho corpus search semantics", () => {
  const documents = [
    fictionalCorpusDocument({
      documentId: 21,
      publicationNumber: "JP2099-000021A",
      applicationNumber: "JP2098-APP-ALPHA",
      publicationDate: "20990103",
      inventionTitle: "FICTIONAL optical sensor",
    }),
    fictionalCorpusDocument({
      documentId: 22,
      publicationNumber: "JP2099-000022A",
      applicationNumber: "JP2098-APP-BETA",
      publicationDate: "20990102",
      inventionTitle: "架空の熱交換器",
      sourceSha256: SOURCE_SHA_2,
      contentSha256: CONTENT_SHA_2,
    }),
    fictionalCorpusDocument({
      documentId: 23,
      publicationNumber: "JP2099-000023A",
      applicationNumber: "JP2098-APP-GAMMA",
      publicationDate: "20990101",
      inventionTitle: "架空の制御装置",
    }),
  ];

  it.each([
    ["000021", 21],
    ["app-beta", 22],
    ["制御装置", 23],
    ["OPTICAL", 21],
  ])(
    "matches publication number, application number, or title for %s",
    (query, expectedDocumentId) => {
      const result = searchKohoCorpusDocuments(documents, query, 20);

      expect(result.map((item) => item.documentId)).toEqual([
        expectedDocumentId,
      ]);
    },
  );

  it("treats percent, underscore, and backslash as literal characters", () => {
    const literal = fictionalCorpusDocument({
      documentId: 31,
      inventionTitle: "literal %_\\ marker",
      publicationDate: "20990201",
    });
    const wildcardLookalike = fictionalCorpusDocument({
      documentId: 32,
      inventionTitle: "literal anything marker",
      publicationDate: "20990202",
    });

    expect(
      searchKohoCorpusDocuments(
        [wildcardLookalike, literal],
        "%_\\",
        20,
      ).map((item) => item.documentId),
    ).toEqual([31]);
  });

  it("sorts deterministically and applies the limit after sorting", () => {
    const unsorted = [
      fictionalCorpusDocument({
        documentId: 44,
        publicationDate: "20990102",
        publicationNumber: "JP2099-000002A",
        inventionTitle: "共通架空語",
      }),
      fictionalCorpusDocument({
        documentId: 43,
        publicationDate: "20990103",
        publicationNumber: "JP2099-000003A",
        inventionTitle: "共通架空語",
      }),
      fictionalCorpusDocument({
        documentId: 42,
        publicationDate: "20990103",
        publicationNumber: "JP2099-000001A",
        inventionTitle: "共通架空語",
      }),
      fictionalCorpusDocument({
        documentId: 41,
        publicationDate: "20990103",
        publicationNumber: "JP2099-000001A",
        inventionTitle: "共通架空語",
      }),
    ];

    expect(
      searchKohoCorpusDocuments(unsorted, "共通架空語", 3).map(
        (item) => item.documentId,
      ),
    ).toEqual([41, 42, 43]);
  });

  it("returns only the public summary and truncates by Unicode code point", () => {
    const source = fictionalCorpusDocument({
      documentId: 51,
      abstractText: "😀".repeat(301),
    });

    const [summary] = searchKohoCorpusDocuments([source], "000001", 20);

    expect(Object.keys(summary)).toEqual([
      "documentId",
      "packageType",
      "parseStatus",
      "kind",
      "publicationNumber",
      "applicationNumber",
      "publicationDate",
      "inventionTitle",
      "abstractPreview",
    ]);
    expect(Array.from(summary.abstractPreview ?? "")).toHaveLength(300);
    expect(summary.abstractPreview).toBe("😀".repeat(300));
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("claimsText");
    expect(serialized).not.toContain("sourceSha256");
    expect(serialized).not.toContain("contentSha256");
    expect(serialized).not.toContain("normalizedEntryPath");
    expect(serialized).not.toContain("applicantsJson");
    expect(serialized).not.toContain("rawXml");
  });

  it("preserves a null abstract preview", () => {
    const [summary] = searchKohoCorpusDocuments(
      [fictionalCorpusDocument({ abstractText: null })],
      "000001",
      20,
    );

    expect(summary.abstractPreview).toBeNull();
  });
});

describe("koho corpus attach request", () => {
  it("accepts the exact body with one to fifty positive safe integers", () => {
    const ids = [1, 2, Number.MAX_SAFE_INTEGER];

    expect(validateKohoCorpusAttachRequest({ documentIds: ids })).toEqual(ids);
    expect(
      validateKohoCorpusAttachRequest({
        documentIds: Array.from({ length: 50 }, (_, index) => index + 1),
      }),
    ).toHaveLength(50);
  });

  it.each([
    null,
    undefined,
    [],
    "not-an-object",
    {},
    { documentIds: "1" },
    { documentIds: [] },
    { documentIds: [1], extra: true },
    { documentIds: Array.from({ length: 51 }, (_, index) => index + 1) },
    { documentIds: [1.5] },
    { documentIds: [0] },
    { documentIds: [-1] },
    { documentIds: [Number.MAX_SAFE_INTEGER + 1] },
    { documentIds: [Number.NaN] },
    { documentIds: [Number.POSITIVE_INFINITY] },
    { documentIds: [1, 1] },
  ])("rejects a non-exact attach body", (body) => {
    expectDomainCode(
      () => validateKohoCorpusAttachRequest(body),
      "invalid_request",
    );
  });
});

describe("koho corpus snapshot projection", () => {
  it("projects exactly the case prior-art fields and canonical provenance", () => {
    const source = fictionalCorpusDocument();

    const snapshot = buildKohoCorpusSnapshot(7, source);

    expect(Object.keys(snapshot)).toEqual([
      "caseId",
      "publicationNo",
      "title",
      "abstract",
      "claimsText",
      "normalizedElementsJson",
      "sourceCsvRowJson",
    ]);
    expect(snapshot).toEqual({
      caseId: 7,
      publicationNo: "JP2099-000001A",
      title: "架空の光学センサー",
      abstract: "架空の要約です。",
      claimsText: "【請求項１】架空のセンサー。",
      normalizedElementsJson: null,
      sourceCsvRowJson:
        `{"source":"koho-corpus","packageType":"JPA",` +
        `"sourceSha256":"${SOURCE_SHA_1}",` +
        `"normalizedEntryPath":"normalized/P_A1/fictional-document.xml",` +
        `"parseStatus":"success","kind":"A1",` +
        `"publicationDate":"20990102",` +
        `"contentSha256":"${CONTENT_SHA_1}"}`,
    });
    expect(Object.keys(JSON.parse(snapshot.sourceCsvRowJson))).toEqual([
      "source",
      "packageType",
      "sourceSha256",
      "normalizedEntryPath",
      "parseStatus",
      "kind",
      "publicationDate",
      "contentSha256",
    ]);
  });

  it("supports review_required and nullable abstract without adding source data", () => {
    const source = fictionalCorpusDocument({
      documentId: 12,
      packageType: "JPB",
      parseStatus: "review_required",
      kind: "B1",
      abstractText: null,
      sourceSha256: SOURCE_SHA_2,
      contentSha256: CONTENT_SHA_2,
    });

    const snapshot = buildKohoCorpusSnapshot(8, source);
    const provenance = JSON.parse(snapshot.sourceCsvRowJson) as Record<
      string,
      unknown
    >;

    expect(snapshot.abstract).toBeNull();
    expect(provenance).toMatchObject({
      source: "koho-corpus",
      packageType: "JPB",
      parseStatus: "review_required",
      kind: "B1",
    });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "FICTIONAL-RAW-XML-SENTINEL",
      "FICTIONAL-RAW-CSV-SENTINEL",
      "FICTIONAL-DESCRIPTION-SENTINEL",
      "FICTIONAL-REFERENCE-SENTINEL",
      "FICTIONAL-IMAGE-SENTINEL",
      "FICTIONAL-ATTACHMENT-SENTINEL",
      "FICTIONAL-APPLICANT-SENTINEL",
      "FICTIONAL-IPC-SENTINEL",
      "FICTIONAL-FI-SENTINEL",
      "FICTIONAL-PARSE-ISSUE-SENTINEL",
      "FICTIONAL-PARSE-ISSUE-MESSAGE-SENTINEL",
      "FICTIONAL-ROOT-SENTINEL",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  const invalidSourceContractCases: Array<
    [string, Partial<CorpusDocumentFixture>]
  > = [
    ["invalid source digest", { sourceSha256: "A".repeat(64) }],
    ["invalid content digest", { contentSha256: "not-a-digest" }],
    ["invalid publication date", { publicationDate: "20991340" }],
    ["backslash entry path", { normalizedEntryPath: "normalized\\bad.xml" }],
    ["incompatible package and kind", { packageType: "JPA", kind: "B1" }],
  ];

  it.each(invalidSourceContractCases)("rejects persisted source contract violations: %s", (_name, override) => {
    expectDomainCode(
      () => buildKohoCorpusSnapshot(7, fictionalCorpusDocument(override)),
      "koho_corpus_unavailable",
    );
  });
});

describe("koho corpus attach merge plan", () => {
  it("classifies insert, update, and unchanged while preserving update docId", () => {
    const unchangedSource = fictionalCorpusDocument({ documentId: 61 });
    const updateSource = fictionalCorpusDocument({
      documentId: 62,
      publicationNumber: "JP2099-000062A",
      inventionTitle: "更新後の架空発明",
      sourceSha256: SOURCE_SHA_2,
      contentSha256: CONTENT_SHA_2,
    });
    const insertSource = fictionalCorpusDocument({
      documentId: 63,
      publicationNumber: "JP2099-000063A",
      inventionTitle: "新規の架空発明",
    });
    const unchangedSnapshot = buildKohoCorpusSnapshot(7, unchangedSource);
    const updateSnapshot = buildKohoCorpusSnapshot(7, updateSource);

    const plan = buildKohoCorpusAttachPlan({
      caseId: 7,
      documentIds: [61, 62, 63],
      documents: [insertSource, unchangedSource, updateSource],
      existingDocuments: [
        existingPriorArt(701, unchangedSnapshot),
        existingPriorArt(702, updateSnapshot, {
          title: "更新前の架空発明",
        }),
      ],
    });

    expect(plan.selected).toBe(3);
    expect(plan.inserted).toEqual([
      {
        sourceDocumentId: 63,
        snapshot: buildKohoCorpusSnapshot(7, insertSource),
      },
    ]);
    expect(plan.updated).toEqual([
      {
        sourceDocumentId: 62,
        docId: 702,
        snapshot: updateSnapshot,
      },
    ]);
    expect(plan.unchanged).toEqual([
      { sourceDocumentId: 61, docId: 701 },
    ]);
    expect(plan.analysisCleared).toBe(true);
  });

  it.each([
    ["title", "別の架空名称"],
    ["abstract", "別の架空要約"],
    ["claimsText", "別の架空請求項"],
    ["normalizedElementsJson", "{\"stale\":true}"],
    ["sourceCsvRowJson", "{\"source\":\"stale\"}"],
  ])("updates when snapshot field %s differs", (field, staleValue) => {
    const source = fictionalCorpusDocument({ documentId: 71 });
    const snapshot = buildKohoCorpusSnapshot(7, source);
    const existing = existingPriorArt(711, snapshot, {
      [field]: staleValue,
    });

    const plan = buildKohoCorpusAttachPlan({
      caseId: 7,
      documentIds: [71],
      documents: [source],
      existingDocuments: [existing],
    });

    expect(plan.updated).toEqual([
      { sourceDocumentId: 71, docId: 711, snapshot },
    ]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.analysisCleared).toBe(true);
  });

  it("does not invalidate analysis when every selected snapshot is unchanged", () => {
    const first = fictionalCorpusDocument({ documentId: 81 });
    const second = fictionalCorpusDocument({
      documentId: 82,
      publicationNumber: "JP2099-000082A",
    });

    const plan = buildKohoCorpusAttachPlan({
      caseId: 7,
      documentIds: [81, 82],
      documents: [first, second],
      existingDocuments: [
        existingPriorArt(801, buildKohoCorpusSnapshot(7, first)),
        existingPriorArt(802, buildKohoCorpusSnapshot(7, second)),
      ],
    });

    expect(plan.inserted).toEqual([]);
    expect(plan.updated).toEqual([]);
    expect(plan.unchanged).toHaveLength(2);
    expect(plan.analysisCleared).toBe(false);
  });

  it("rejects a missing selected document without returning a partial plan", () => {
    const source = fictionalCorpusDocument({ documentId: 91 });

    expectDomainCode(
      () =>
        buildKohoCorpusAttachPlan({
          caseId: 7,
          documentIds: [91, 92],
          documents: [source],
          existingDocuments: [],
        }),
      "koho_document_not_found",
    );
  });

  it("rejects duplicate global IDs defensively", () => {
    const source = fictionalCorpusDocument({ documentId: 93 });

    expectDomainCode(
      () =>
        buildKohoCorpusAttachPlan({
          caseId: 7,
          documentIds: [93, 93],
          documents: [source],
          existingDocuments: [],
        }),
      "invalid_request",
    );
  });

  it("rejects different global documents with the same publication number", () => {
    const first = fictionalCorpusDocument({ documentId: 94 });
    const second = fictionalCorpusDocument({
      documentId: 95,
      sourceSha256: SOURCE_SHA_2,
      contentSha256: CONTENT_SHA_2,
    });

    expectDomainCode(
      () =>
        buildKohoCorpusAttachPlan({
          caseId: 7,
          documentIds: [94, 95],
          documents: [first, second],
          existingDocuments: [],
        }),
      "ambiguous_publication_selection",
    );
  });

  it("rejects duplicate existing rows for the selected publication", () => {
    const source = fictionalCorpusDocument({ documentId: 951 });
    const snapshot = buildKohoCorpusSnapshot(7, source);

    expectDomainCode(
      () =>
        buildKohoCorpusAttachPlan({
          caseId: 7,
          documentIds: [951],
          documents: [source],
          existingDocuments: [
            existingPriorArt(9511, snapshot),
            existingPriorArt(9512, snapshot),
          ],
        }),
      "koho_corpus_unavailable",
    );
  });

  it("is idempotent when the same global document is attached repeatedly", async () => {
    const source = fictionalCorpusDocument({ documentId: 96 });
    const store = new AtomicFakeCaseStore(
      [],
      ["FICTIONAL-ANALYSIS-RESULT"],
    );
    const firstPlan = await store.attach({
      caseId: 7,
      documentIds: [96],
      documents: [source],
    });
    const rowCountAfterFirstAttach = store.priorArt.length;
    const secondPlan = await store.attach({
      caseId: 7,
      documentIds: [96],
      documents: [source],
    });

    expect(firstPlan.inserted).toHaveLength(1);
    expect(firstPlan.analysisCleared).toBe(true);
    expect(rowCountAfterFirstAttach).toBe(1);
    expect(store.priorArt).toHaveLength(rowCountAfterFirstAttach);
    expect(secondPlan.inserted).toEqual([]);
    expect(secondPlan.updated).toEqual([]);
    expect(secondPlan.unchanged).toEqual([
      { sourceDocumentId: 96, docId: 10_000 },
    ]);
    expect(secondPlan.analysisCleared).toBe(false);
  });

  it("does not mutate source or existing document inputs", () => {
    const source = fictionalCorpusDocument({ documentId: 97 });
    const snapshot = buildKohoCorpusSnapshot(7, source);
    const existing = existingPriorArt(970, snapshot, {
      title: "古い架空名称",
    });
    const beforeSource = structuredClone(source);
    const beforeExisting = structuredClone(existing);

    buildKohoCorpusAttachPlan({
      caseId: 7,
      documentIds: [97],
      documents: [source],
      existingDocuments: [existing],
    });

    expect(source).toEqual(beforeSource);
    expect(existing).toEqual(beforeExisting);
  });

  it("supports rollback of prior-art and analysis in a transactional fake", async () => {
    const source = fictionalCorpusDocument({ documentId: 98 });
    const originalSnapshot = buildKohoCorpusSnapshot(
      7,
      fictionalCorpusDocument({
        documentId: 98,
        inventionTitle: "更新前の架空名称",
      }),
    );
    const store = new AtomicFakeCaseStore(
      [existingPriorArt(980, originalSnapshot)],
      ["FICTIONAL-ANALYSIS-RESULT"],
    );
    const beforePriorArt = structuredClone(store.priorArt);
    const beforeAnalysis = structuredClone(store.analysis);

    await expect(
      store.attach({
        caseId: 7,
        documentIds: [98],
        documents: [source],
        failAfterPriorArtWrite: true,
      }),
    ).rejects.toThrow("FICTIONAL-TRANSACTION-FAILURE");

    expect(store.priorArt).toEqual(beforePriorArt);
    expect(store.analysis).toEqual(beforeAnalysis);
  });
});

class AtomicFakeCaseStore {
  priorArt: Array<Record<string, unknown>>;
  analysis: string[];
  private nextDocId = 10_000;

  constructor(
    priorArt: Array<Record<string, unknown>>,
    analysis: string[],
  ) {
    this.priorArt = structuredClone(priorArt);
    this.analysis = [...analysis];
  }

  async attach(input: {
    caseId: number;
    documentIds: number[];
    documents: CorpusDocumentFixture[];
    failAfterPriorArtWrite?: boolean;
  }) {
    const beforePriorArt = structuredClone(this.priorArt);
    const beforeAnalysis = [...this.analysis];

    try {
      const plan = buildKohoCorpusAttachPlan({
        caseId: input.caseId,
        documentIds: input.documentIds,
        documents: input.documents,
        existingDocuments: this.priorArt,
      });

      for (const operation of plan.inserted) {
        this.priorArt.push({
          docId: this.nextDocId,
          ...operation.snapshot,
        });
        this.nextDocId += 1;
      }
      for (const operation of plan.updated) {
        const index = this.priorArt.findIndex(
          (document) => document.docId === operation.docId,
        );
        this.priorArt[index] = {
          docId: operation.docId,
          ...operation.snapshot,
        };
      }

      if (input.failAfterPriorArtWrite) {
        throw new Error("FICTIONAL-TRANSACTION-FAILURE");
      }
      if (plan.analysisCleared) this.analysis = [];
      return plan;
    } catch (error) {
      this.priorArt = beforePriorArt;
      this.analysis = beforeAnalysis;
      throw error;
    }
  }
}
