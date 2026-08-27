import { describe, expect, it } from "vitest";
import type {
  CaseRepository,
  KohoImportRepository,
} from "../../repositories";

describe("KohoImportRepository public contract", () => {
  it("adds the koho repository without changing existing repository exports", () => {
    const existingMethods: Array<keyof CaseRepository> = [
      "findAll",
      "findById",
      "create",
      "update",
      "remove",
    ];
    const kohoMethods: Array<keyof KohoImportRepository> = [
      "savePlan",
      "findRunBySource",
      "findDocumentsByRunId",
    ];

    expect(existingMethods).toContain("findById");
    expect(kohoMethods).toEqual([
      "savePlan",
      "findRunBySource",
      "findDocumentsByRunId",
    ]);
  });
});
