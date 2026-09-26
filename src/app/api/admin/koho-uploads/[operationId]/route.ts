import { withOwnerRoute } from "@/lib/owner-http";
import { kohoUploadHandlers } from "@/lib/koho-import/upload-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const handlers = kohoUploadHandlers();
type Context = { params: Promise<{ operationId: string }> };
export const GET = withOwnerRoute(async (r: Request, c: Context) => handlers.status(r, (await c.params).operationId));
export const POST = withOwnerRoute(async (r: Request, c: Context) => handlers.action(r, (await c.params).operationId));
