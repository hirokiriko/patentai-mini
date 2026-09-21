import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fictionalDraft, mixedDrafts } from "../../../lib/current-draft-fixtures.test-support";
const seam = vi.hoisted(() => ({ case: vi.fn(), drafts: vi.fn(), saved: vi.fn(), request: vi.fn() }));
vi.mock("@/repositories", () => ({ caseRepo: { findById: seam.case }, draftPatentRepo: { findByCaseId: seam.drafts },
  searchQuerySetRepo: { findByCaseId: seam.saved }, priorArtDocumentRepo: { findByCaseId: seam.saved }, comparisonResultRepo: { findByCaseId: seam.saved } }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, useRouter: () => ({ refresh: seam.request, push: seam.request }),
  usePathname: () => "/cases/7", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/current-draft", () => import("../../../lib/current-draft"));
vi.mock("@/lib/safe-json", () => import("../../../lib/safe-json"));
vi.mock("@/lib/original-file-metadata", () => import("../../../lib/original-file-metadata"));
vi.mock("@/lib/patent-keyword-assist", () => import("../../../lib/patent-keyword-assist"));
vi.mock("@/lib/claim-draft-check", () => import("../../../lib/claim-draft-check"));
vi.mock("@/lib/api-response", () => import("../../../lib/api-response"));
vi.mock("@/lib/patent-watch/period", () => import("../../../lib/patent-watch/period"));
vi.mock("@/components/toast", () => import("../../../components/toast"));
vi.mock("@/components/step-progress-bar", () => import("../../../components/step-progress-bar"));
vi.mock("@/components/next-action-banner", () => import("../../../components/next-action-banner"));
vi.mock("@/components/jplatpat-guide", () => import("../../../components/jplatpat-guide"));
vi.mock("@/components/step-scroll-handler", () => import("../../../components/step-scroll-handler"));
vi.mock("@/components/copy-button", () => import("../../../components/copy-button"));
vi.mock("@/components/scroll-to-top", () => import("../../../components/scroll-to-top"));
import Page from "./page";

beforeEach(() => {
  vi.clearAllMocks(); seam.case.mockResolvedValue({ caseId: 7, title: "完全架空の資料選択試験", status: "draft",
    baseApplicationMode: false, baseApplicationNumber: null, createdAt: "2099-03-01" });
  seam.drafts.mockResolvedValue(mixedDrafts()); seam.saved.mockResolvedValue([]);
});
const render = async () => renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: "7" }) }));
async function optionalPreview(name: string, html: string) {
  const output = process.env.CURRENT_DRAFT_PREVIEW_OUTPUT;
  if (!output) return;
  const { mkdir, writeFile } = await import("node:fs/promises"); const { join, resolve } = await import("node:path");
  if (resolve(output) !== resolve(".koho-ops/issue117-preview")) throw Error("preview_output_refused");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `${name}.html`), `<!doctype html><html lang="ja"><meta charset="utf-8"><title>完全架空・資料選択確認</title><link rel="stylesheet" href="/style.css"><body><p>完全架空の表示検証。実AI・DB・本番操作なし。操作ボタンは未接続。</p>${html}</body></html>`);
}
describe("actual case page source selection", () => {
  it("shows the latest main and retains uploaded history", async () => {
    const html = await render();
    expect(html).toMatch(/現在の比較・ウォッチ対象: fictional-main-9.txt/);
    expect(html).toContain("抽出結果9の架空請求項"); expect(html).not.toContain("抽出結果2の架空請求項");
    expect(html).toContain("fictional-main-2.txt"); expect(html).toContain("現在の対象資料");
    expect(html).toContain("保存済み結果と現在の資料の対応は未確認"); expect(seam.request).not.toHaveBeenCalled();
    await optionalPreview("latest", html);
  });
  it("shows the unextracted latest file without borrowing old claims", async () => {
    seam.drafts.mockResolvedValue([fictionalDraft(1), fictionalDraft(8, "main", { extractedClaimsJson: null })]);
    const html = await render();
    expect(html).toContain("現在の比較・ウォッチ対象: fictional-main-8.txt");
    expect(html).not.toContain("抽出結果1の架空請求項"); expect(html).not.toContain("抽出結果8の架空請求項");
    expect(html).toContain("その資料の請求項を抽出してください"); await optionalPreview("unextracted", html);
  });
  it("uses current base and addition in base mode without inferring main", async () => {
    seam.case.mockResolvedValue({ caseId: 7, title: "完全架空の統合試験", baseApplicationMode: true });
    seam.drafts.mockResolvedValue(mixedDrafts().filter(draft => draft.kind !== "main"));
    const html = await render();
    expect(html).toContain("現在の比較・ウォッチ対象: 未登録");
    expect(html).toContain("fictional-base-90.txt"); expect(html).not.toContain("fictional-base-10.txt");
    expect(html).toContain("fictional-addition-60.txt"); expect(html).not.toContain("fictional-addition-11.txt");
    expect(html).toContain("保存済みの統合結果への反映は自動確認していません");
    expect(html).not.toContain("抽出結果90の架空請求項"); await optionalPreview("base", html);
  });
  it("guides normal mode to upload main when only non-main history exists", async () => {
    seam.drafts.mockResolvedValue([fictionalDraft(20, "base"), fictionalDraft(21, "addition")]);
    const html = await render();
    expect(html).toContain("現在の比較・ウォッチ対象: 未登録");
    expect(html).not.toContain('次に「請求項を抽出」');
    expect(html).toContain("まず、特許案のファイルをアップロードしてください");
    await optionalPreview("normal", html);
  });
});
