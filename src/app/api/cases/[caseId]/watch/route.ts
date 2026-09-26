import { withOwnerRoute } from "@/lib/owner-http";
import { createPatentWatchHandlers } from "@/lib/patent-watch/api";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createPatentWatchHandlers({ repository: patentWatchRepo });

 const handleGET = handlers.GET;
 const handlePUT = handlers.PUT;

export const GET = withOwnerRoute(handleGET);
export const PUT = withOwnerRoute(handlePUT);
