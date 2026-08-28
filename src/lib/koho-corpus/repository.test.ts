import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const DRIZZLE_REPOSITORY_URL = new URL(
  "../../repositories/drizzle.ts",
  import.meta.url,
);

async function repositorySource(): Promise<string> {
  return readFile(DRIZZLE_REPOSITORY_URL, "utf8");
}

describe("koho corpus Drizzle boundary", () => {
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
    expect(attach).toContain("tx\n            .delete(comparisonResults)");
    expect(attach.match(/\.delete\(comparisonResults\)/g)).toHaveLength(1);

    const invalidationStart = attach.indexOf("if (plan.analysisCleared)");
    const deleteStart = attach.indexOf(".delete(comparisonResults)");
    const resultStart = attach.indexOf("return {", invalidationStart);
    expect(invalidationStart).toBeGreaterThan(callbackStart);
    expect(deleteStart).toBeGreaterThan(invalidationStart);
    expect(resultStart).toBeGreaterThan(deleteStart);
  });
});
