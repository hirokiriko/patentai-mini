import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fictionalSaved } from "../../../../lib/prior-art-comparison/fixtures.test-support";
const seam = vi.hoisted(() => ({ requireOwner: vi.fn(), catalog: vi.fn(), saved: vi.fn() }));
vi.mock("@/lib/owner-http", () => ({ requireOwner: seam.requireOwner }));
vi.mock("@/lib/prior-art-comparison/repository", () => ({ comparisonCatalog: seam.catalog, listComparisons: seam.saved }));
vi.mock("@/lib/prior-art-comparison/http", () => import("../../../../lib/prior-art-comparison/http"));
vi.mock("@/lib/prior-art-comparison/report", () => import("../../../../lib/prior-art-comparison/report"));
vi.mock("@/lib/prior-art-comparison/availability", () => import("../../../../lib/prior-art-comparison/availability"));
vi.mock("@/lib/prior-art-comparison/limits", () => import("../../../../lib/prior-art-comparison/limits"));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import Page from "./page";
const saved = fictionalSaved();
const render = async () => renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: "7" }) }));
beforeEach(() => {
  vi.resetAllMocks();
  seam.catalog.mockResolvedValue({ caseId: 7, title: "完全架空", inputDigest: saved.inputs.inputDigest, draft: { source: saved.inputs.draft }, documents: [] });
  seam.saved.mockResolvedValue({ results: [saved], currentInputDigest: saved.inputs.inputDigest, pendingOperationIds: [], failedOperations: [], reservedCount: 0, invalidCount: 0, legacyCount: 0 });
});
afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "0", "invalid", "1"])("reflects server admission while retaining saved results (%s)", async enabled => {
  vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", enabled);
  const html = await render();
  expect(html.includes('<fieldset disabled=""')).toBe(enabled !== "1");
  expect(html.includes("新しい比較の受付を停止しています")).toBe(enabled !== "1");
  expect(html).toContain("OWNER限定の試験版"); expect(html).toContain("原文と照合して確認");
  expect(html).toContain("PDFを取得"); expect(html).toContain("CSVを取得");
  expect(html).toContain(saved.operationId); expect(html).toContain("保存結果を再読込（AI送信なし）");
});
it("keeps previous success visible beside failed and unconfirmed operations", async () => {
  vi.stubEnv("PRIOR_ART_COMPARISON_ENABLED", "1");
  const value = await seam.saved();
  seam.saved.mockResolvedValue({ ...value, reservedCount: 2, failedOperations: [{ operationId: "failed-fictional", failure: { stage: "review", kind: "review_rejected" } }] });
  const html = await render();
  expect(html).toContain("品質検証で停止"); expect(html).toContain("完了未確認の試行が1件");
  expect(html).toContain(saved.operationId); expect(html).toContain("PDFを取得");
  expect(html).toContain('<fieldset disabled=""');
});
it("authorizes before reading case data", async () => {
  seam.requireOwner.mockRejectedValue(Error("NOT_FOUND"));
  await expect(render()).rejects.toThrow("NOT_FOUND");
  expect(seam.catalog).not.toHaveBeenCalled(); expect(seam.saved).not.toHaveBeenCalled();
});
