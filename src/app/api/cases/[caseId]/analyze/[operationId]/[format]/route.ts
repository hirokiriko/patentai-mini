import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { getComparison } from "@/lib/prior-art-comparison/repository";
import { comparisonCsv, comparisonPdf } from "@/lib/prior-art-comparison/report";
import { caseNumber, comparisonFailure } from "@/lib/prior-art-comparison/http";
import { ComparisonError } from "@/lib/prior-art-comparison/source";
import { PeriodPdfError } from "@/lib/patent-watch/period-report-pdf";

export const runtime = "nodejs";
export const GET = withOwnerRoute(async (_request: Request, context: { params: Promise<{ caseId: string; operationId: string; format: string }> }) => {
  try {
    const { caseId, operationId, format } = await context.params;
    if (!z.uuid().safeParse(operationId).success || !["pdf", "csv"].includes(format)) throw new ComparisonError("not_found");
    const { saved, stale } = await getComparison(caseNumber(caseId), operationId);
    const body = format === "pdf" ? new Uint8Array(await comparisonPdf(saved, stale)) : comparisonCsv(saved, stale);
    return new Response(body, { headers: { "Content-Type": format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="comparison-${operationId}.${format}"` } });
  } catch (error) {
    if (error instanceof PeriodPdfError) return Response.json({ code: "export_unavailable", error: "PDFの文字・ページ数・出力環境を確認してください。保存済み比較結果は保持しています。CSVは別途取得できます。" }, { status: 422 });
    return comparisonFailure(error);
  }
});
