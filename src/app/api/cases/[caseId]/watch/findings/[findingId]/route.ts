import { withOwnerRoute } from "@/lib/owner-http";
import { createPatentWatchFindingHandlers } from "@/lib/patent-watch/api";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createPatentWatchFindingHandlers({
  repository: patentWatchRepo,
});

 const handlePATCH = handlers.PATCH;

export const PATCH = withOwnerRoute(handlePATCH);
