import { describe, expect, it, vi } from "vitest";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { parse } from "csv-parse/sync";
import { mkdir, writeFile } from "node:fs/promises";
import { generateManagedDeliveryPdf, managedDeliveryBlocks, managedDeliveryCsv, managedExplanation, managedExplanations, validateManagedDelivery } from "./managed-delivery";
import { managedDeliveryFixture } from "./managed-delivery.test-support";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
describe("managed immutable delivery display", () => {
  it("keeps all fields protected and CSV formulas neutral even after invisible prefixes", () => {
    const r = managedDeliveryFixture();
    r.base.publicationNumber = "api_key=FICTIONAL_PRIVATE_SENTINEL";
    r.base.version = "C:\\Users\\fictional\\private";
    r.findings[0].inventionTitle = "api_key=FICTIONAL_PRIVATE_SENTINEL";
    r.findings[0].publicationNumber = "\u200b=1+1";
    r.findings[0].comparisons[0].explanation = "The claim is invalid.";
    const before = structuredClone(r), blocks = JSON.stringify([...managedDeliveryBlocks(r)]);
    expect(blocks).not.toMatch(/FICTIONAL_PRIVATE_SENTINEL|C:\\\\Users|The claim is invalid/);
    const rows = parse(managedDeliveryCsv(r), { bom: true });
    expect(rows[0]).toHaveLength(45); expect(rows[1]).toHaveLength(45);
    expect(managedDeliveryCsv(r).toString()).not.toMatch(/FICTIONAL_PRIVATE_SENTINEL|C:\\\\Users|The claim is invalid/);
    expect(rows[1][6]).toBe("'\u200b=1+1"); expect(r).toEqual(before);
  });
  it("blocks normalized full-claim quotations and fragments distributed across candidates", () => {
    const full = "架空の検出装置及び制御部";
    expect(managedExplanation("架空 の 検出 装置 及び 制御部", [full])).not.toContain("検出");
    expect(managedExplanations(["架空の検出装置", "及び制御部"], [full]).join("")).not.toContain("検出");
  });
  it("rejects contradictory completeness and distinguishes complete zero from failure", () => {
    const r = managedDeliveryFixture(0); r.coverage.incompleteDocuments = 1;
    expect(() => validateManagedDelivery(r)).toThrow("incomplete");
    expect(managedDeliveryCsv(managedDeliveryFixture(0)).toString()).toContain("詳細比較候補0件");
    expect(managedDeliveryCsv(managedDeliveryFixture(0, false)).toString()).toContain("未完了のため候補の有無は未確定");
    const missing=managedDeliveryFixture(0,false),csv=parse(managedDeliveryCsv(missing),{bom:true,columns:true}) as Record<string,string>[];
    expect(csv[0]["監視元公開番号"]).toBe(missing.base.publicationNumber);expect(csv[0]["取得確認日時"]).toBe(missing.coverage.acquiredAt);
    expect(csv[0]["不足連絡用文案"]).toContain("補足・訂正版");expect(csv[0]["不足連絡用文案"]).toContain(missing.period.from);
  });
  it("renders real Japanese PDFs with every explanation tail, page number, evidence offset and no AI", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("no network"));
    try {
      const r = managedDeliveryFixture(4), explanation = "架空の日本語比較説明と原文確認。".repeat(60) + "説明末尾到達";
      r.findings[0].comparisons[0].explanation = explanation;
      const bytes = await generateManagedDeliveryPdf(r), { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
      const pages: string[] = [];
      try {
        for (let i = 1; i <= pdf.numPages; i++) {
          const p = await pdf.getPage(i), text = (await p.getTextContent()).items.map(item => "str" in item ? item.str : "").join("").replace(/\s/g, "");
          expect(text).toContain(`${i}/${pdf.numPages}`); expect(await p.getAnnotations()).toEqual([]); pages.push(text);
        }
      } finally { await pdf.destroy(); }
      const text = pages.join(""); expect(pages.length).toBeGreaterThan(1);
      for (const expected of ["2026-07-26", "2026-08-25", "2026-08-31", "監視元請求項1", "2010〜2020", "4050〜4060", "説明末尾到達", "法的判断ではなく", "候補#4"]) expect(text).toContain(expected);
      expect(fetch).not.toHaveBeenCalled();
      if (process.env.PERIOD_PDF_QA === "1") { await mkdir(".koho-ops/pdf-qa", { recursive: true }); await writeFile(".koho-ops/pdf-qa/managed-long.pdf", bytes); }
    } finally { fetch.mockRestore(); }
  }, 30_000);
});
