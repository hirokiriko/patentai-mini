// Node-only: consumes the validated, sanitized model; never reads a database or URL.
import PDFDocument from "pdfkit";
import { resolve } from "node:path";
import { setImmediate as yieldToStream } from "node:timers/promises";
import { isValidPatentWatchTimestamp } from "./domain";
import { periodDateTimeLabel } from "./period";
import type { PeriodReportModel } from "./period-report";

export const PERIOD_PDF_LIMITS = { bytes: 16 * 1024 * 1024, characters: 1_000_000, pages: 200, milliseconds: 15_000 } as const;
export class PeriodPdfError extends Error {
  constructor(public readonly reason: "limit" | "glyph" | "unavailable") { super(`period_pdf_${reason}`); }
}
export type PeriodPdfOrigin = { kind: "saved" } | { kind: "archive"; preservedAt: string };
type Block = { text: string; heading?: boolean };

/** Explicit display projection. Extra properties, raw JSON, URLs and IDs never become metadata or links. */
function* blocks(report: PeriodReportModel, origin: PeriodPdfOrigin, generatedAt: string): Generator<Block> {
  const p = (text: string): Block => ({ text });
  const h = (text: string): Block => ({ text, heading: true });
  yield h(`案件 #${report.caseId} の期間レポート`);
  yield p("出願後ウォッチング");
  if (origin.kind === "archive") {
    yield h("本番保存結果の保全版から生成");
    yield p("本番ブラウザー印刷の再現ではない。削除済み案件の保存結果を帳票化したものです。案件・単一runへの稼働中リンクはありません。");
    yield p(`保全日時: ${periodDateTimeLabel(origin.preservedAt)}`);
  }
  yield p(`対象期間: ${report.period.from} 〜 ${report.period.to}（両端を含む）`);
  yield p("集計基準: 監視実行開始日（日本時間）。公報の発行期間・出願期間・全公報の網羅期間とは異なります。");
  yield p(`レポート作成日時（保存結果の時点）: ${periodDateTimeLabel(report.createdAt)}`);
  yield p(`PDF生成日時: ${periodDateTimeLabel(generatedAt)}`);
  if (report.summary.failed || report.summary.running) yield h("不完全なレポート：失敗・実行中の監視を含みます。完了した実行の保存済み候補のみを表示しています。");
  yield h("期間の集計");
  yield p(`実行件数: ${report.runs.length}件（完了 ${report.summary.completed}件 ／ 失敗 ${report.summary.failed}件 ／ 実行中 ${report.summary.running}件）`);
  yield p(`完了した実行の新規候補数: ${report.findings.length}件`);
  yield p(`未確認 ${report.summary.unreviewed}件 ／ 確認済み ${report.summary.reviewed}件 ／ AI ${report.summary.ai}件 ／ fallback ${report.summary.fallback}件`);
  yield p("確認状態はレポート作成時点の保存状態です。当時の状態履歴や専門家確認済みの所見を示すものではありません。");
  yield h("確認候補");
  if (report.summary.ai) {
    yield h("AI比較の範囲");
    yield p("分析がaiの候補について、現行の比較方法を説明しています。自案の独立請求項（独立請求項が抽出されていない場合は全請求項）と、公報の要約および請求項テキストの先頭最大2,000文字を比較します。明細書全文や請求項の残りは比較範囲に含みません。");
    yield p("差分候補は入力範囲で一致を確認できない内容です。公報全体に記載がないという意味ではありません。Lowでも原文を確認してください。");
    yield p("各結果の実際の入力文字数や切断の有無を示す記録ではありません。fallback候補はAI詳細比較の結果ではありません。");
  }
  if (!report.runs.length) yield p("実行記録なし：この期間に開始した保存済みの監視実行はありません。公報の取得状況や比較結果は判断できません。");
  else if (!report.summary.completed) yield p("完了した実行がありません。新規候補の有無は未確定です。");
  else if (!report.findings.length) yield p("完了した実行の新規候補は0件です。過去に初検出済みの候補は再計上していません。");
  for (const f of report.findings) {
    yield h(`候補 #${f.findingId}: ${f.publicationNumber} · ${f.inventionTitle}`);
    yield p(`公開日: ${f.publicationDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1/$2/$3")} ／ 初回検出: ${periodDateTimeLabel(f.firstSeenAt)} ／ 初検出run #${f.firstRunId}`);
    yield p(`risk label（AI比較の参考）: ${f.riskLabel} ／ 分析: ${f.analysisMode} ／ 確認状態: ${f.reviewStatus === "reviewed" ? "確認済み" : "未確認"}`);
    yield p(`語彙 ${Math.round(f.lexicalScore * 100)}% ／ 要素 ${Math.round(f.elementScore * 100)}% ／ 意味 ${Math.round(f.semanticScore * 100)}% ／ 構造 ${Math.round(f.structuralScore * 100)}%`);
    yield h("一致候補");
    for (const text of f.matchedElements.length ? f.matchedElements : ["明示された候補はありません"]) yield p(`・${text}`);
    yield h("差分候補");
    for (const text of f.unmatchedElements.length ? f.unmatchedElements : ["明示された候補はありません"]) yield p(`・${text}`);
    yield p(f.explanation);
  }
  yield h("対象の監視実行");
  const status = { completed: "完了", failed: "失敗", running: "実行中" };
  for (const run of report.runs) {
    yield p(`run #${run.runId} ／ 開始 ${periodDateTimeLabel(run.startedAt)} ／ ${status[run.status]} ／ 新規候補 ${run.status === "completed" ? `${run.newFindingCount}件` : "未確定"}`);
  }
  yield h("レポートの範囲と原文確認");
  yield p("対象は各実行時の取り込み済み公報です。対象期間の全公開公報の取得完了や全件のAI精読は保証しません。");
  yield p("本レポートは確認候補を整理するもので、法的判断ではありません。risk labelはAI比較の参考であり、法的危険度・対応義務・専門家の確定所見を示しません。人による原文確認が必要です。");
  yield p("自己案件の除外や「他社」の判定は保証しません。公開番号を使ってJ-PlatPat等で原文を確認してください。専門家の所見は印刷物や既存の単一run CSVへ外部で追記できます。");
}

/** Finite, cooperative Node generation. Call only with buildPeriodReport/readPeriodReport output. */
export async function generatePeriodReportPdf(report: PeriodReportModel, origin: PeriodPdfOrigin = { kind: "saved" }): Promise<Buffer> {
  const deadline = performance.now() + PERIOD_PDF_LIMITS.milliseconds;
  const checkTime = () => { if (performance.now() >= deadline) throw new PeriodPdfError("limit"); };
  let doc: PDFKit.PDFDocument | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (origin.kind === "archive" && !isValidPatentWatchTimestamp(origin.preservedAt)) throw new PeriodPdfError("unavailable");
    const font = resolve(process.cwd(), "assets/fonts/NotoSansJP-Regular.otf");
    checkTime();
    doc = new PDFDocument({ size: "A4", margins: { top: 42, bottom: 54, left: 44, right: 44 },
      font, bufferPages: true, info: { Title: "出願後ウォッチング 期間レポート", Author: "", Creator: "patentai-mini", Producer: "PDFKit" } });
    const pdf = doc;
    // PDFKit's pinned embedded-font adapter exposes fontkit's cmap check. Fail closed if it changes.
    const embedded = (pdf as unknown as { _font: { font: { hasGlyphForCodePoint(code: number): boolean } } })._font.font;
    if (typeof embedded?.hasGlyphForCodePoint !== "function") throw new PeriodPdfError("unavailable");
    const glyphs = new Set<number>();
    const chunks: Buffer[] = [];
    let bytes = 0, pages = 1, characters = 0;
    let failure: PeriodPdfError | undefined;
    const fail = (error: PeriodPdfError) => { failure ??= error; pdf.destroy(error); };
    const completed = new Promise<Buffer>((accept, reject) => {
      pdf.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > PERIOD_PDF_LIMITS.bytes) fail(new PeriodPdfError("limit"));
        else chunks.push(chunk);
      });
      pdf.on("error", () => reject(failure ?? new PeriodPdfError("unavailable")));
      pdf.on("end", () => failure ? reject(failure) : accept(Buffer.concat(chunks)));
    });
    // Register immediately, including while layout is yielding, to avoid unhandled rejections.
    void completed.catch(() => undefined);
    timer = setTimeout(() => fail(new PeriodPdfError("limit")), Math.max(1, deadline - performance.now()));
    pdf.on("pageAdded", () => { checkTime(); if (++pages > PERIOD_PDF_LIMITS.pages) throw new PeriodPdfError("limit"); });
    for (const block of blocks(report, origin, new Date().toISOString())) {
      checkTime(); if (failure) throw failure;
      // Normalize layout whitespace only; never truncate a paragraph or list.
      const text = block.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
      characters += text.length;
      if (characters > PERIOD_PDF_LIMITS.characters) throw new PeriodPdfError("limit");
      for (const character of text) {
        const code = character.codePointAt(0)!;
        if (code === 10 || glyphs.has(code)) continue;
        if (!embedded.hasGlyphForCodePoint(code)) throw new PeriodPdfError("glyph");
        glyphs.add(code);
      }
      if (block.heading && pdf.y > pdf.page.height - 115) pdf.addPage();
      pdf.fontSize(block.heading ? 12 : 10).fillColor(block.heading ? "#18344b" : "#202a33")
        .text(text, { lineGap: 3, paragraphGap: 3 });
      pdf.moveDown(block.heading ? 0.35 : 0.2);
      await yieldToStream();
    }
    const range = pdf.bufferedPageRange();
    for (let index = 0; index < range.count; index++) {
      checkTime(); if (failure) throw failure;
      pdf.switchToPage(index);
      const bottom = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0;
      pdf.fontSize(8).fillColor("#52606d").text(`${index + 1} / ${range.count}`, 44, pdf.page.height - 34,
        { width: pdf.page.width - 88, align: "center", lineBreak: false });
      pdf.page.margins.bottom = bottom;
    }
    pdf.end();
    const result = await completed;
    checkTime();
    return result;
  } catch (error) {
    // No raw error, text, font path or partial PDF leaves this boundary.
    doc?.destroy();
    throw error instanceof PeriodPdfError ? error : new PeriodPdfError("unavailable");
  } finally { clearTimeout(timer); }
}
