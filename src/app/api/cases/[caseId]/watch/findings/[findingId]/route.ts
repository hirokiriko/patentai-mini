import { createPatentWatchFindingHandlers } from "@/lib/patent-watch/api";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createPatentWatchFindingHandlers({
  repository: patentWatchRepo,
});

export const PATCH = handlers.PATCH;
