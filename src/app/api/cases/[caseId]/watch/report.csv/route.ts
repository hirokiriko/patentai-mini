import { createPatentWatchCsvHandlers } from "@/lib/patent-watch/api";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createPatentWatchCsvHandlers({
  repository: patentWatchRepo,
});

export const GET = handlers.GET;
