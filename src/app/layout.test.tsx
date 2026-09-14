import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import RootLayout from "./layout";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
}));

it("renders Japanese language and one public/fictional-data notice before app input", () => {
  const html = renderToStaticMarkup(<RootLayout><main><input name="fictional-input" /></main></RootLayout>);
  expect(html).toContain('lang="ja"');
  expect(html.match(/試用版の利用範囲/g)).toHaveLength(1);
  expect(html).toContain("公開公報・完全架空データを対象とした試用版です。");
  expect(html).toContain("未公開発明・顧客資料・個人情報を入力・アップロードしないでください。");
  expect(html).toContain("結果は調査支援であり、人による確認が必要です。");
  expect(html.indexOf("試用版の利用範囲")).toBeLessThan(html.indexOf("fictional-input"));
});
