import { describe, expect, it } from "vitest";

import { createKohoCorpusHandlers } from "./api";
import { KohoCorpusDomainError } from "./domain";

interface SearchSummaryFixture {
  documentId: number;
  packageType: "JPA" | "JPB";
  parseStatus: "success" | "review_required";
  kind: "A1" | "P1" | "B1" | "B2";
  publicationNumber: string;
  applicationNumber: string;
  publicationDate: string;
  inventionTitle: string;
  abstractPreview: string | null;
  [key: string]: unknown;
}

interface AttachResultFixture {
  selected: number;
  inserted: number;
  updated: number;
  unchanged: number;
  analysisCleared: boolean;
  [key: string]: unknown;
}

function fictionalSummary(
  overrides: Partial<SearchSummaryFixture> = {},
): SearchSummaryFixture {
  return {
    documentId: 11,
    packageType: "JPA",
    parseStatus: "success",
    kind: "A1",
    publicationNumber: "JP2099-000001A",
    applicationNumber: "JP2098-000001",
    publicationDate: "20990102",
    inventionTitle: "架空の光学センサー",
    abstractPreview: "架空の要約です。",
    ...overrides,
  };
}

class FakeKohoCorpusRepository {
  readonly searchCalls: Array<{
    caseId: number;
    query: string;
    limit: number;
  }> = [];
  readonly attachCalls: Array<{
    caseId: number;
    documentIds: number[];
  }> = [];

  searchResult: SearchSummaryFixture[] = [];
  attachResult: AttachResultFixture = {
    selected: 1,
    inserted: 1,
    updated: 0,
    unchanged: 0,
    analysisCleared: true,
  };
  searchError: unknown;
  attachError: unknown;

  async searchForCase(caseId: number, query: string, limit: number) {
    this.searchCalls.push({ caseId, query, limit });
    if (this.searchError !== undefined) throw this.searchError;
    return this.searchResult;
  }

  async attachToCase(caseId: number, documentIds: number[]) {
    this.attachCalls.push({ caseId, documentIds: [...documentIds] });
    if (this.attachError !== undefined) throw this.attachError;
    return this.attachResult;
  }
}

function routeContext(caseId = "7") {
  return { params: Promise.resolve({ caseId }) };
}

function searchRequest(
  configure: (params: URLSearchParams) => void,
) {
  const url = new URL("http://localhost/api/cases/7/koho-corpus");
  configure(url.searchParams);
  return new Request(url);
}

function jsonPostRequest(body: unknown) {
  return new Request("http://localhost/api/cases/7/koho-corpus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawPostRequest(body: string) {
  return new Request("http://localhost/api/cases/7/koho-corpus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function responseBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("koho corpus GET handler", () => {
  it("normalizes search input, delegates once, and returns items", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.searchResult = [fictionalSummary()];
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => {
      params.set("q", "  JP2099-000001A  ");
    });

    const response = await GET(request, routeContext());
    const body = await responseBody(response);

    expect(response.status).toBe(200);
    expect(repository.searchCalls).toEqual([
      { caseId: 7, query: "JP2099-000001A", limit: 20 },
    ]);
    expect(Object.keys(body)).toEqual(["items"]);
    expect(body).toEqual({ items: [fictionalSummary()] });
  });

  it("passes an explicit boundary limit", async () => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => {
      params.set("q", "架空");
      params.set("limit", "50");
    });

    const response = await GET(request, routeContext());

    expect(response.status).toBe(200);
    expect(repository.searchCalls).toEqual([
      { caseId: 7, query: "架空", limit: 50 },
    ]);
    expect(await responseBody(response)).toEqual({ items: [] });
  });

  it("passes percent, underscore, and backslash as literal query text", async () => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => {
      params.set("q", "%_\\");
    });

    const response = await GET(request, routeContext());

    expect(response.status).toBe(200);
    expect(repository.searchCalls).toEqual([
      { caseId: 7, query: "%_\\", limit: 20 },
    ]);
  });

  it.each([
    ["missing q", (params: URLSearchParams) => params],
    ["empty q", (params: URLSearchParams) => params.set("q", "")],
    ["blank q", (params: URLSearchParams) => params.set("q", "   ")],
    ["short q", (params: URLSearchParams) => params.set("q", "a")],
    [
      "long q",
      (params: URLSearchParams) => params.set("q", "あ".repeat(101)),
    ],
  ])("returns invalid_query for %s", async (_name, configure) => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const response = await GET(searchRequest(configure), routeContext());

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ error: "invalid_query" });
    expect(repository.searchCalls).toEqual([]);
  });

  it.each([
    "0",
    "51",
    "1.5",
    "+1",
    "-1",
    " 1",
    "１",
    "not-a-number",
  ])("returns invalid_limit for %s", async (limit) => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => {
      params.set("q", "架空");
      params.set("limit", limit);
    });

    const response = await GET(request, routeContext());

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ error: "invalid_limit" });
    expect(repository.searchCalls).toEqual([]);
  });

  it("rejects duplicate limit parameters before repository access", async () => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => {
      params.set("q", "架空");
      params.append("limit", "1");
      params.append("limit", "2");
    });

    const response = await GET(request, routeContext());

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ error: "invalid_limit" });
    expect(repository.searchCalls).toEqual([]);
  });

  it("rejects duplicate q parameters before repository access", async () => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => {
      params.append("q", "架空");
      params.append("q", "公報");
    });

    const response = await GET(request, routeContext());

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ error: "invalid_query" });
    expect(repository.searchCalls).toEqual([]);
  });

  it("whitelists every search item field", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.searchResult = [
      fictionalSummary({
        claimsText: "FICTIONAL-CLAIMS-LEAK",
        sourceSha256: "FICTIONAL-SOURCE-HASH-LEAK",
        contentSha256: "FICTIONAL-CONTENT-HASH-LEAK",
        normalizedEntryPath: "FICTIONAL-ENTRY-PATH-LEAK",
        rawJson: "FICTIONAL-RAW-JSON-LEAK",
      }),
    ];
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => params.set("q", "架空"));

    const response = await GET(request, routeContext());
    const body = await responseBody(response);
    const item = (body.items as Array<Record<string, unknown>>)[0];

    expect(response.status).toBe(200);
    expect(Object.keys(item)).toEqual([
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
    const text = JSON.stringify(body);
    expect(text).not.toContain("FICTIONAL-CLAIMS-LEAK");
    expect(text).not.toContain("FICTIONAL-SOURCE-HASH-LEAK");
    expect(text).not.toContain("FICTIONAL-CONTENT-HASH-LEAK");
    expect(text).not.toContain("FICTIONAL-ENTRY-PATH-LEAK");
    expect(text).not.toContain("FICTIONAL-RAW-JSON-LEAK");
  });

  it.each([
    ["case_not_found", 404, "case_not_found"],
    ["koho_corpus_unavailable", 503, "koho_corpus_unavailable"],
  ] as const)(
    "maps domain error %s to a stable response",
    async (code, status, expectedCode) => {
      const repository = new FakeKohoCorpusRepository();
      repository.searchError = new KohoCorpusDomainError(code);
      const { GET } = createKohoCorpusHandlers({ repository });
      const request = searchRequest((params) => params.set("q", "架空"));

      const response = await GET(request, routeContext());

      expect(response.status).toBe(status);
      expect(await responseBody(response)).toEqual({ error: expectedCode });
    },
  );

  it("sanitizes an unexpected search failure", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.searchError = new Error(
      "FICTIONAL-RAW-DB-MESSAGE claims=SECRET path=SECRET hash=SECRET",
    );
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => params.set("q", "架空"));

    const response = await GET(request, routeContext());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe(
      JSON.stringify({ error: "koho_corpus_internal_error" }),
    );
    expect(text).not.toContain("FICTIONAL-RAW-DB-MESSAGE");
    expect(text).not.toContain("SECRET");
  });

  it("returns case_not_found for a safe integer outside the serial range", async () => {
    const repository = new FakeKohoCorpusRepository();
    const { GET } = createKohoCorpusHandlers({ repository });
    const request = searchRequest((params) => params.set("q", "架空"));

    const response = await GET(request, routeContext("2147483648"));

    expect(response.status).toBe(404);
    expect(await responseBody(response)).toEqual({ error: "case_not_found" });
    expect(repository.searchCalls).toEqual([]);
  });
});

describe("koho corpus POST handler", () => {
  it("accepts the exact body, delegates once, and returns exact counts", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.attachResult = {
      selected: 3,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      analysisCleared: true,
    };
    const { POST } = createKohoCorpusHandlers({ repository });

    const response = await POST(
      jsonPostRequest({ documentIds: [11, 12, 13] }),
      routeContext(),
    );
    const body = await responseBody(response);

    expect(response.status).toBe(200);
    expect(repository.attachCalls).toEqual([
      { caseId: 7, documentIds: [11, 12, 13] },
    ]);
    expect(Object.keys(body)).toEqual([
      "selected",
      "inserted",
      "updated",
      "unchanged",
      "analysisCleared",
    ]);
    expect(body).toEqual({
      selected: 3,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      analysisCleared: true,
    });
  });

  it("accepts fifty unique IDs", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.attachResult = {
      selected: 50,
      inserted: 50,
      updated: 0,
      unchanged: 0,
      analysisCleared: true,
    };
    const { POST } = createKohoCorpusHandlers({ repository });
    const ids = Array.from({ length: 50 }, (_, index) => index + 1);

    const response = await POST(
      jsonPostRequest({ documentIds: ids }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(repository.attachCalls).toEqual([{ caseId: 7, documentIds: ids }]);
  });

  it.each([
    ["top-level null", null],
    ["top-level array", []],
    ["missing key", {}],
    ["non-array", { documentIds: "11" }],
    ["empty array", { documentIds: [] }],
    ["extra key", { documentIds: [11], extra: true }],
    [
      "fifty-one IDs",
      { documentIds: Array.from({ length: 51 }, (_, index) => index + 1) },
    ],
    ["fraction", { documentIds: [1.5] }],
    ["zero", { documentIds: [0] }],
    ["negative", { documentIds: [-1] }],
    ["unsafe integer", { documentIds: [Number.MAX_SAFE_INTEGER + 1] }],
    ["duplicate", { documentIds: [11, 11] }],
  ])("rejects %s as invalid_request", async (_name, body) => {
    const repository = new FakeKohoCorpusRepository();
    const { POST } = createKohoCorpusHandlers({ repository });

    const response = await POST(jsonPostRequest(body), routeContext());

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ error: "invalid_request" });
    expect(repository.attachCalls).toEqual([]);
  });

  it("rejects malformed JSON before repository access", async () => {
    const repository = new FakeKohoCorpusRepository();
    const { POST } = createKohoCorpusHandlers({ repository });

    const response = await POST(rawPostRequest("{not-json"), routeContext());

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ error: "invalid_request" });
    expect(repository.attachCalls).toEqual([]);
  });

  it("whitelists attach result fields", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.attachResult = {
      selected: 1,
      inserted: 1,
      updated: 0,
      unchanged: 0,
      analysisCleared: true,
      claimsText: "FICTIONAL-CLAIMS-LEAK",
      normalizedEntryPath: "FICTIONAL-ENTRY-PATH-LEAK",
      sourceSha256: "FICTIONAL-HASH-LEAK",
      dbMessage: "FICTIONAL-DB-MESSAGE-LEAK",
    };
    const { POST } = createKohoCorpusHandlers({ repository });

    const response = await POST(
      jsonPostRequest({ documentIds: [11] }),
      routeContext(),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toBe(
      JSON.stringify({
        selected: 1,
        inserted: 1,
        updated: 0,
        unchanged: 0,
        analysisCleared: true,
      }),
    );
    expect(text).not.toContain("FICTIONAL-CLAIMS-LEAK");
    expect(text).not.toContain("FICTIONAL-ENTRY-PATH-LEAK");
    expect(text).not.toContain("FICTIONAL-HASH-LEAK");
    expect(text).not.toContain("FICTIONAL-DB-MESSAGE-LEAK");
  });

  it.each([
    ["case_not_found", 404, "case_not_found"],
    ["koho_document_not_found", 404, "koho_document_not_found"],
    [
      "ambiguous_publication_selection",
      409,
      "ambiguous_publication_selection",
    ],
    ["koho_corpus_unavailable", 503, "koho_corpus_unavailable"],
  ] as const)(
    "maps domain error %s to a stable response",
    async (code, status, expectedCode) => {
      const repository = new FakeKohoCorpusRepository();
      repository.attachError = new KohoCorpusDomainError(code);
      const { POST } = createKohoCorpusHandlers({ repository });

      const response = await POST(
        jsonPostRequest({ documentIds: [11] }),
        routeContext(),
      );

      expect(response.status).toBe(status);
      expect(await responseBody(response)).toEqual({ error: expectedCode });
    },
  );

  it("sanitizes an unexpected attach failure without echoing input", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.attachError = new Error(
      "FICTIONAL-RAW-DB-MESSAGE claims=SECRET path=SECRET hash=SECRET",
    );
    const { POST } = createKohoCorpusHandlers({ repository });

    const response = await POST(
      jsonPostRequest({ documentIds: [987654321] }),
      routeContext(),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe(
      JSON.stringify({ error: "koho_corpus_internal_error" }),
    );
    expect(text).not.toContain("FICTIONAL-RAW-DB-MESSAGE");
    expect(text).not.toContain("987654321");
    expect(text).not.toContain("SECRET");
  });

  it("delegates a safe integer outside the serial range and maps repository not-found", async () => {
    const repository = new FakeKohoCorpusRepository();
    repository.attachError = new KohoCorpusDomainError(
      "koho_document_not_found",
    );
    const { POST } = createKohoCorpusHandlers({ repository });

    const response = await POST(
      jsonPostRequest({ documentIds: [Number.MAX_SAFE_INTEGER] }),
      routeContext(),
    );

    expect(response.status).toBe(404);
    expect(await responseBody(response)).toEqual({
      error: "koho_document_not_found",
    });
    expect(repository.attachCalls).toEqual([
      { caseId: 7, documentIds: [Number.MAX_SAFE_INTEGER] },
    ]);
  });
});
