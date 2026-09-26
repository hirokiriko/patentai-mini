import { withOwnerRoute } from "@/lib/owner-http";
import { createPatentWatchCsvHandlers } from "@/lib/patent-watch/api";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createPatentWatchCsvHandlers({
  repository: patentWatchRepo,
});

 const handleGET = handlers.GET;

export const GET = withOwnerRoute(handleGET);
