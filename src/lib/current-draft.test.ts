import { beforeEach, describe, expect, it, vi } from "vitest";
import { latestDraft } from "./current-draft";
import { fictionalDraft, mixedDrafts } from "./current-draft-fixtures.test-support";
import type { DraftPatent } from "../repositories/types";

const seam = vi.hoisted(() => ({ case: vi.fn(), drafts: vi.fn(), prior: vi.fn(), queries: vi.fn(), screen: vi.fn(),
  analyze: vi.fn(), integrate: vi.fn(), saveQueries: vi.fn(), saveResults: vi.fn(), upsert: vi.fn() }));
vi.mock("@/repositories", () => ({ caseRepo: { findById: seam.case }, draftPatentRepo: { findByCaseId: seam.drafts, upsertMain: seam.upsert },
  priorArtDocumentRepo: { findByCaseId: seam.prior }, searchQuerySetRepo: { create: seam.saveQueries }, comparisonResultRepo: { replaceByCaseId: seam.saveResults } }));
vi.mock("@/lib/current-draft", () => import("./current-draft"));
vi.mock("@/lib/safe-json", () => import("./safe-json"));
vi.mock("@/lib/generate-queries", () => ({ generateQueries: seam.queries }));
vi.mock("@/lib/analyze-overlap", () => ({ screenPriorArt: seam.screen, analyzeOverlap: seam.analyze }));
vi.mock("@/lib/integrate-claims", () => ({ integrateClaims: seam.integrate }));
vi.mock("@/lib/ai-operation-budget", () => ({ isAiOperationStopped: () => false }));
import { POST as queries } from "../app/api/cases/[caseId]/queries/route";
import { POST as analyze } from "../app/api/cases/[caseId]/analyze/route";
import { POST as integrate } from "../app/api/cases/[caseId]/integrate/route";
const context = () => ({ params: Promise.resolve({ caseId: "7" }) });
const request = () => new Request("http://localhost/fictional", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  seam.case.mockResolvedValue({ caseId: 7, baseApplicationMode: true, baseApplicationNumber: null });
  seam.drafts.mockResolvedValue(mixedDrafts()); seam.prior.mockResolvedValue([{ docId: 17, publicationNo: "FICTIONAL", title: "架空", abstract: "架空" }]);
  seam.screen.mockResolvedValue({ relevantDocIds: [17], reasoning: "架空選定" }); seam.analyze.mockResolvedValue([]);
  seam.queries.mockResolvedValue({ broadQuery: "架空", balancedQuery: "架空", narrowQuery: "架空", rationale: [] });
  seam.integrate.mockResolvedValue({ integratedText: "架空統合本文" }); seam.upsert.mockResolvedValue(fictionalDraft(9));
  seam.saveQueries.mockResolvedValue({ querySetId: 1 }); seam.saveResults.mockResolvedValue(0);
});

describe("current draft selection through real routes", () => {
  it("selects by kind and maximum ID independently of row order without mutation", () => {
    const rows = mixedDrafts(), before = structuredClone(rows);
    for (const order of [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]]) {
      expect(latestDraft(order, "main")?.draftId).toBe(9);
      expect(latestDraft(order, "base")?.draftId).toBe(90);
      expect(latestDraft(order, "addition")?.draftId).toBe(60);
    }
    expect(rows).toEqual(before); expect(latestDraft([], "main")).toBeUndefined();
  });
  it.each([queries, analyze])("passes the exact latest main claims into the model boundary", async post => {
    expect((await post(request(), context())).status).toBeLessThan(300);
    const expected = JSON.parse(fictionalDraft(9).extractedClaimsJson!);
    expect((post === queries ? seam.queries : seam.screen).mock.calls[0][0]).toEqual(expected);
    if (post === analyze) expect(seam.analyze.mock.calls[0][0]).toEqual(expected);
  });
  it.each([null, "", " ", "{broken"])("does not use older prepared claims when newest main is %s", async value => {
    seam.drafts.mockResolvedValue([fictionalDraft(1), fictionalDraft(2, "main", { extractedClaimsJson: value }), fictionalDraft(99, "base")]);
    for (const post of [queries, analyze]) expect((await post(request(), context())).status).toBe(400);
    for (const fn of [seam.queries, seam.screen, seam.analyze, seam.saveQueries, seam.saveResults]) expect(fn).not.toHaveBeenCalled();
  });
  it.each([[], [fictionalDraft(3, "base"), fictionalDraft(4, "addition")],
    [fictionalDraft(8, "main", { kind: "" as DraftPatent["kind"] })],
    [fictionalDraft(8, "main", { kind: null as unknown as DraftPatent["kind"] })]].map(rows => ({ rows })))("does not infer missing main from another kind", async ({ rows }) => {
    seam.drafts.mockResolvedValue(rows);
    for (const post of [queries, analyze]) expect((await post(request(), context())).status).toBe(400);
    expect(seam.screen).not.toHaveBeenCalled(); expect(seam.queries).not.toHaveBeenCalled();
  });
  it("preserves the single-main case and case-not-found boundaries", async () => {
    seam.drafts.mockResolvedValue([fictionalDraft(1)]);
    expect((await queries(request(), context())).status).toBe(201);
    expect(seam.queries.mock.calls[0][0]).toEqual(JSON.parse(fictionalDraft(1).extractedClaimsJson!));
    vi.clearAllMocks(); seam.case.mockResolvedValue(null);
    for (const post of [queries, analyze, integrate]) expect((await post(request(), context())).status).toBe(404);
    expect(seam.drafts).not.toHaveBeenCalled(); expect(seam.queries).not.toHaveBeenCalled();
  });
  it("integrates the latest base and addition, then updates main through the existing repository", async () => {
    expect((await integrate(request(), context())).status).toBe(200);
    expect(seam.integrate).toHaveBeenCalledExactlyOnceWith({ baseText: "架空本文90", additionText: "架空本文60", baseApplicationNumber: null });
    expect(seam.upsert).toHaveBeenCalledWith(expect.objectContaining({ caseId: 7, parsedText: "架空統合本文" }));
  });
  it.each(["base", "addition"] as const)("does not integrate an old %s when latest has no text", async kind => {
    seam.drafts.mockResolvedValue([...mixedDrafts(), fictionalDraft(101, kind, { parsedText: null })]);
    expect((await integrate(request(), context())).status).toBe(400);
    expect(seam.integrate).not.toHaveBeenCalled(); expect(seam.upsert).not.toHaveBeenCalled();
  });
});
