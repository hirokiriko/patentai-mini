import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectFindingBibliography } from "../../../../../../lib/patent-watch/bibliography";
import { applicantJson, bibliographyFixture } from "../../../../../../lib/patent-watch/bibliography-fixtures.test-support";
import { BibliographyView } from "./bibliography-view";

const seam = vi.hoisted(() => ({ readFindingBibliography: vi.fn() }));
vi.mock("@/repositories", () => ({ patentWatchRepo: seam }));
vi.mock("@/lib/patent-watch/period", () => import("../../../../../../lib/patent-watch/period"));
vi.mock("@/lib/patent-watch/bibliography", () => import("../../../../../../lib/patent-watch/bibliography"));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
import Page from "./page";
beforeEach(() => vi.resetAllMocks());
describe("bibliography page", () => {
  it.each(["0", "-1", "1x", "01", "2147483648", "1.1"])("404s invalid IDs before reading: %s", async value => {
    await expect(Page({ params: Promise.resolve({ caseId: "7", findingId: value }) })).rejects.toThrow("NOT_FOUND");
    await expect(Page({ params: Promise.resolve({ caseId: value, findingId: "11" }) })).rejects.toThrow("NOT_FOUND");
    expect(seam.readFindingBibliography).not.toHaveBeenCalled();
  });
  it("404s missing and cross-case findings without disclosing existence", async () => {
    seam.readFindingBibliography.mockResolvedValue(null);
    await expect(Page({ params: Promise.resolve({ caseId: "7", findingId: "11" }) })).rejects.toThrow("NOT_FOUND");
    expect(seam.readFindingBibliography).toHaveBeenCalledWith(7, 11);
  });
  it("contains raw DB errors, shows provenance failure and retains warnings", async () => {
    seam.readFindingBibliography.mockRejectedValue(Error("FICTIONAL_PRIVATE_SENTINEL"));
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: "7", findingId: "11" }) }));
    expect(html).toContain("書誌情報を確認できません"); expect(html).toContain("法的結論ではありません"); expect(html).not.toContain("FICTIONAL_PRIVATE_SENTINEL");
  });
  it("renders safe text, matching run anchor, explicit copy controls and print notices", () => {
    const fixture = bibliographyFixture(); fixture.document.applicantsJson = applicantJson(["<script>alert('fictional')</script>", "架空 太郎"]);
    const html = renderToStaticMarkup(<BibliographyView caseId={7} result={{ kind: "ready", finding: projectFindingBibliography(fixture) }} />);
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain('/cases/7/watch/runs/3#finding-11'); expect(html).toContain("出願番号をコピー");
    expect(html).toContain("最新の権利者"); expect(html).toContain("自己案件除外済みとはしません");
    expect(html).toContain("番号・種別・請求項"); expect(html).toContain("出典の状態");
    expect(html).toContain("nav, button, .print-hidden"); expect(html).toContain("overflow-wrap: anywhere");
    expect(html).not.toMatch(/sourceKey|contentSha256|documentId|applicantsJson|sourceValue/);
  });
});
