import { withOwnerRoute } from "@/lib/owner-http";
import { kohoUploadHandlers } from "@/lib/koho-import/upload-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const handlers = kohoUploadHandlers();
export const GET = withOwnerRoute(handlers.metadata);
export const POST = withOwnerRoute(handlers.create);
