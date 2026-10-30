import { after } from "next/server";
import { withOwnerRoute } from "@/lib/owner-http";
import { selectionSchema } from "@/lib/prior-art-comparison/comparison";
import { comparisonCatalog, listComparisons, reserveComparison, completeReservedComparison } from "@/lib/prior-art-comparison/repository";
import { caseNumber, comparisonFailure } from "@/lib/prior-art-comparison/http";
import { ComparisonError } from "@/lib/prior-art-comparison/source";
import { comparisonEnabled } from "@/lib/prior-art-comparison/availability";

// Deployment metadata; the comparison scope also enforces its own deadline.
export const maxDuration = 5640;
type Context = { params: Promise<{ caseId: string }> };
export const GET = withOwnerRoute(async (request: Request, { params }: Context) => {
  try {
    const id = caseNumber((await params).caseId);
    const operationId = new URL(request.url).searchParams.get("operationId");
    if (operationId !== null) {
      if (!selectionSchema.shape.operationId.safeParse(operationId).success) throw new ComparisonError("selection_invalid");
      const saved = await listComparisons(id);
      const complete = saved.results.find(result => result.operationId === operationId);
      const failed = saved.failedOperations.find(result => result.operationId === operationId);
      return Response.json({ operationId, ...(failed ? { failure: failed.failure } : {}), status: complete ? "complete" : failed ? "failed" : saved.pendingOperationIds.includes(operationId) ? "reserved" : "unconfirmed" });
    }
    return Response.json({ enabled: comparisonEnabled(), catalog: await comparisonCatalog(id), saved: await listComparisons(id) });
  } catch (error) { return comparisonFailure(error); }
});
export const POST = withOwnerRoute(async (request: Request, { params }: Context) => {
  try {
    if (!comparisonEnabled()) return Response.json({ code: "comparison_disabled", error: "新しい比較の受付を停止しています。保存結果の表示・取得と実行中操作の状態確認は利用できます。" }, { status: 503 });
    const id = caseNumber((await params).caseId);
    const reader = request.body?.getReader();
    if (!reader) throw new ComparisonError("selection_invalid");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 8192) { await reader.cancel(); throw new ComparisonError("selection_invalid"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let selection;
    try { selection = selectionSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new ComparisonError("selection_invalid"); }
    const reservation = await reserveComparison(id, selection);
    if (reservation.existing) return Response.json({ status: "complete", operationId: reservation.existing.operationId, generatedAt: reservation.existing.generatedAt });
    if (!reservation.pending) {
      after(async () => {
        try { await completeReservedComparison(id, selection, reservation); }
        catch { /* Reservation remains durable. Never retry after failure or restart. */ }
      });
    }
    return Response.json({ status: "reserved", operationId: selection.operationId }, { status: 202 });
  } catch (error) { return comparisonFailure(error); }
});
