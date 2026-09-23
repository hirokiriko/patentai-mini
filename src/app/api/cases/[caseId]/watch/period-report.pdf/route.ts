import { withOwnerRoute } from "@/lib/owner-http";
import { patentWatchRepo } from "@/repositories";
import { parsePeriodQuery, periodCaseId, PERIOD_QUERY_MESSAGE } from "@/lib/patent-watch/period";
import { readPeriodReport } from "@/lib/patent-watch/period-report";
import { generatePeriodReportPdf, PeriodPdfError } from "@/lib/patent-watch/period-report-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status: number, error: string, message: string) => Response.json({ error, message }, { status, headers });
const limit = () => failure(413, "period_pdf_limit", "対象が多いため期間を短くしてください。PDF全体を生成できませんでした。");

 async function handleGET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const caseId = periodCaseId((await params).caseId);
  const search = new URL(request.url).searchParams;
  const query: Record<string, string | string[]> = Object.create(null);
  for (const key of search.keys()) { const values = search.getAll(key); query[key] = values.length === 1 ? values[0] : values; }
  const parsed = parsePeriodQuery(query);
  if (caseId === null || parsed.kind !== "valid") return failure(400, "invalid_period", PERIOD_QUERY_MESSAGE);
  const result = await readPeriodReport(patentWatchRepo, caseId, parsed.period);
  if (result.kind === "not_found") return failure(404, "case_not_found", "案件が見つかりません。");
  if (result.kind === "too_many") return limit();
  if (result.kind !== "ready") return failure(503, "period_unavailable", "データ取得不能：候補0件とは判断できません。");
  try {
    const bytes = await generatePeriodReportPdf(result.report);
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="period-report-${caseId}-${parsed.period.from}-${parsed.period.to}.pdf"` } });
  } catch (error) {
    if (error instanceof PeriodPdfError && error.reason === "limit") return limit();
    if (error instanceof PeriodPdfError && error.reason === "glyph") return failure(422, "period_pdf_glyph", "使用できない文字があるためPDFを生成できません。期間画面で内容を確認してください。");
    return failure(503, "period_pdf_unavailable", "PDFを生成できませんでした。期間画面で内容を確認してください。");
  }
}

export const GET = withOwnerRoute(handleGET);
