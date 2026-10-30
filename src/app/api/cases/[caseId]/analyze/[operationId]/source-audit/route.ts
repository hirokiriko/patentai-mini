import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { getComparisonSourceAudit } from "@/lib/prior-art-comparison/repository";
import { caseNumber, comparisonFailure } from "@/lib/prior-art-comparison/http";
import { ComparisonError } from "@/lib/prior-art-comparison/source";

export const runtime = "nodejs";
export const GET = withOwnerRoute(async (_request: Request, context: { params: Promise<{ caseId: string; operationId: string }> }) => {
  try {
    const { caseId, operationId } = await context.params;
    if (!z.uuid().safeParse(operationId).success) throw new ComparisonError("not_found");
    const audit = await getComparisonSourceAudit(caseNumber(caseId), operationId);
    return Response.json(audit, { headers: { "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="comparison-source-audit-${operationId}.json"` } });
  } catch (error) { return comparisonFailure(error); }
});
