import { withOwnerRoute } from "@/lib/owner-http";
import { kohoUploadHandlers } from "@/lib/koho-import/upload-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const handlers = kohoUploadHandlers();
export const PUT = withOwnerRoute(async (r: Request, c: { params: Promise<{ operationId: string; index: string }> }) => {
  const p = await c.params; return handlers.chunk(r, p.operationId, p.index);
});
