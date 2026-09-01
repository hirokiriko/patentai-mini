import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import {
  buildKohoImportPlan,
  createKohoImportDocumentPlan,
} from "../koho-import";
import {
  buildMinimalFictionalPackage,
  FICTIONAL_PACKAGE_LIMITS,
} from "../koho-package/__fixtures__/fictional-package";
import { parseKohoPackage } from "../koho-package";
import { toKohoCorpusSourceDocument } from "../../repositories/drizzle";
import {
  buildKohoCorpusSnapshot,
  KohoCorpusDomainError,
  searchKohoCorpusDocuments,
} from "./domain";

const DRIZZLE_REPOSITORY_URL = new URL(
  "../../repositories/drizzle.ts",
  import.meta.url,
);

async function repositorySource(): Promise<string> {
  return readFile(DRIZZLE_REPOSITORY_URL, "utf8");
}

type FictionalImportPlan = ReturnType<typeof buildKohoImportPlan>;

let fictionalImportPlan: FictionalImportPlan;

beforeAll(async () => {
  const packageResult = await parseKohoPackage({
    packageType: "JPA",
    source: {
      type: "buffer",
      bytes: buildMinimalFictionalPackage("JPA"),
      sourceName: "fictional-jpa-package.zip",
    },
    limits: FICTIONAL_PACKAGE_LIMITS,
  });
  fictionalImportPlan = buildKohoImportPlan({
    packageResult,
    sourceSha256: "1".repeat(64),
  });
});

function fictionalPersistenceRows(publicationDate: string) {
  const baseDocument = fictionalImportPlan.documents[0];
  if (!baseDocument) throw new Error("fictional document is required");
  const { contentSha256, ...payload } = baseDocument;
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new Error("fictional document digest is required");
  }
  const document = createKohoImportDocumentPlan({
    ...payload,
    publicationDate,
  });

  return {
    document: {
      documentId: 91,
      importId: 41,
      ...document,
    },
    run: {
      importId: 41,
      packageType: fictionalImportPlan.packageType,
      sourceSha256: fictionalImportPlan.sourceSha256,
      packageStatus: fictionalImportPlan.packageStatus,
      documentCount: fictionalImportPlan.documentCount,
      amendmentCount: fictionalImportPlan.amendmentCount,
      nestedSt26Count: fictionalImportPlan.nestedSt26Count,
      countsJson: fictionalImportPlan.countsJson,
      issuesJson: fictionalImportPlan.issuesJson,
      createdAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

describe("koho corpus Drizzle boundary", () => {
  it("normalizes a persistence-valid leap date for search and snapshot provenance", () => {
    const { document, run } = fictionalPersistenceRows("2024-02-29");

    const source = toKohoCorpusSourceDocument(document, run);
    const [summary] = searchKohoCorpusDocuments(
      [source],
      source.publicationNumber,
      1,
    );
    const snapshot = buildKohoCorpusSnapshot(7, source);
    const provenance = JSON.parse(snapshot.sourceCsvRowJson) as Record<
      string,
      unknown
    >;

    expect(source.publicationDate).toBe("20240229");
    expect(summary.publicationDate).toBe("20240229");
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
    expect(Object.keys(snapshot)).toEqual([
      "caseId",
      "publicationNo",
      "title",
      "abstract",
      "claimsText",
      "normalizedElementsJson",
      "sourceCsvRowJson",
    ]);
    expect(provenance.publicationDate).toBe("20240229");
    expect(Object.keys(provenance)).toEqual([
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

  it("normalizes a regular persistence date deterministically", () => {
    const rows = fictionalPersistenceRows("2099-01-02");

    const first = toKohoCorpusSourceDocument(rows.document, rows.run);
    const second = toKohoCorpusSourceDocument(rows.document, rows.run);

    expect(first.publicationDate).toBe("20990102");
    expect(second).toEqual(first);
  });

  it.each([
    "2023-02-29",
    "2024-02-30",
    "2024/02/29",
    "20240229",
    " 2024-02-29",
  ])("fails closed for a noncanonical persisted date: %s", (publicationDate) => {
    const { document, run } = fictionalPersistenceRows(publicationDate);

    let caught: unknown;
    try {
      toKohoCorpusSourceDocument(document, run);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KohoCorpusDomainError);
    expect(caught).toMatchObject({ code: "koho_corpus_unavailable" });
  });

  it("passes joined run and document rows through the existing persistence validators", async () => {
    const source = await repositorySource();
    const adapterStart = source.indexOf("function toKohoCorpusSourceDocument");
    const adapterEnd = source.indexOf(
      "function toKohoCorpusSearchSummary",
      adapterStart,
    );
    const adapter = source.slice(adapterStart, adapterEnd);

    expect(adapterStart).toBeGreaterThanOrEqual(0);
    expect(adapterEnd).toBeGreaterThan(adapterStart);
    expect(adapter).toContain("toKohoImportRun(runRow)");
    expect(adapter).toContain(
      "toKohoImportDocument(documentRow, run.packageType)",
    );
    expect(source.match(/toKohoCorpusSourceDocument\(document, run\)/g)).toHaveLength(2);
  });

  it("uses literal bound substring search with the required deterministic order", async () => {
    const source = await repositorySource();
    const searchStart = source.indexOf("async searchForCase");
    const attachStart = source.indexOf("async attachToCase", searchStart);
    const search = source.slice(searchStart, attachStart);

    for (const column of [
      "publicationNumber",
      "applicationNumber",
      "inventionTitle",
    ]) {
      expect(search).toContain(
        `strpos(lower(\${kohoImportDocuments.${column}}), lower(cast(\${query} as text))) > 0`,
      );
    }
    expect(search).not.toMatch(/\b(ilike|like)\s*\(/i);
    const orderedFragments = [
      "desc(kohoImportDocuments.publicationDate)",
      "asc(kohoImportDocuments.publicationNumber)",
      "asc(kohoImportDocuments.documentId)",
      ".limit(limit)",
    ];
    let previousIndex = -1;
    for (const fragment of orderedFragments) {
      const fragmentIndex = search.indexOf(fragment);
      expect(fragmentIndex).toBeGreaterThan(previousIndex);
      previousIndex = fragmentIndex;
    }
    expect(search.match(/\.limit\(limit\)/g)).toHaveLength(1);
  });

  it("locks the case and applies merge plus analysis invalidation in one transaction", async () => {
    const source = await repositorySource();
    const attachStart = source.indexOf("async attachToCase");
    const attach = source.slice(attachStart);
    const callbackStart = attach.indexOf("async (tx) => {");
    const callback = attach.slice(callbackStart);

    expect(attach).toContain("db.transaction(async (tx)");
    expect(attach.match(/db\.transaction\(async \(tx\)/g)).toHaveLength(1);
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(callback).not.toMatch(/\bdb\.(?:select|insert|update|delete)\b/);
    expect(attach).toContain('.for("update")');
    expect(attach.indexOf('.for("update")')).toBeLessThan(
      attach.indexOf("documentId > POSTGRES_INTEGER_MAX"),
    );
    expect(attach.indexOf("documentId > POSTGRES_INTEGER_MAX")).toBeLessThan(
      attach.indexOf("inArray(kohoImportDocuments.documentId, documentIds)"),
    );
    expect(attach).toContain("buildKohoCorpusAttachPlan");
    expect(attach).toContain("if (plan.analysisCleared)");
    expect(attach).toMatch(/tx\r?\n\s+\.delete\(comparisonResults\)/);
    expect(attach.match(/\.delete\(comparisonResults\)/g)).toHaveLength(1);

    const invalidationStart = attach.indexOf("if (plan.analysisCleared)");
    const deleteStart = attach.indexOf(".delete(comparisonResults)");
    const resultStart = attach.indexOf("return {", invalidationStart);
    expect(invalidationStart).toBeGreaterThan(callbackStart);
    expect(deleteStart).toBeGreaterThan(invalidationStart);
    expect(resultStart).toBeGreaterThan(deleteStart);
  });
});
