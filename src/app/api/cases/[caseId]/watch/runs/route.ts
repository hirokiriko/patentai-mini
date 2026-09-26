import { withOwnerRoute } from "@/lib/owner-http";
import { withAiOperationBudget } from "@/lib/ai-operation-budget";
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
    withAiOperationBudget({ normal: 6, fast: 0 }, () => runPatentWatch(caseId, {
      repository: patentWatchRepo,
      screenPriorArt,
      analyzeOverlap,
    })),
});

 const handlePOST = handlers.POST;

export const POST = withOwnerRoute(handlePOST);
