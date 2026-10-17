import { withOwnerRoute } from "@/lib/owner-http";
import { selectionSchema } from "@/lib/prior-art-comparison/comparison";
import { comparisonCatalog, listComparisons, runAndSaveComparison } from "@/lib/prior-art-comparison/repository";
import { caseNumber, comparisonFailure } from "@/lib/prior-art-comparison/http";
import { ComparisonError } from "@/lib/prior-art-comparison/source";

// Deployment metadata; the comparison scope also enforces its own deadline.
export const maxDuration = 240;
type Context = { params: Promise<{ caseId: string }> };
export const GET = withOwnerRoute(async (_request: Request, { params }: Context) => {
  try {
    const id = caseNumber((await params).caseId);
    return Response.json({ catalog: await comparisonCatalog(id), saved: await listComparisons(id) });
  } catch (error) { return comparisonFailure(error); }
});
export const POST = withOwnerRoute(async (request: Request, { params }: Context) => {
  try {
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
    const saved = await runAndSaveComparison(id, selection);
    return Response.json({ operationId: saved.operationId, generatedAt: saved.generatedAt });
  } catch (error) { return comparisonFailure(error); }
});
