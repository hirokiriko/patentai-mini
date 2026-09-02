import { screenPriorArt, analyzeOverlap } from "@/lib/analyze-overlap";
import { createPatentWatchRunHandlers } from "@/lib/patent-watch/api";
import { runPatentWatch } from "@/lib/patent-watch/service";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";
// The existing screening and detailed analysis each have a 35-second total
// timeout. Keep a finite request budget with room to finalize the run safely.
export const maxDuration = 120;

const handlers = createPatentWatchRunHandlers({
  executeRun: (caseId) =>
    runPatentWatch(caseId, {
      repository: patentWatchRepo,
      screenPriorArt,
      analyzeOverlap,
    }),
});

export const POST = handlers.POST;
