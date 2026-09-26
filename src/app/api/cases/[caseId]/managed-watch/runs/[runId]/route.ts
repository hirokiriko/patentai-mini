import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError, managedCaseId, managedJson, managedRequestId, managedRequestInput } from "@/lib/patent-watch/managed-api";
import { withManagedDeliveryDatabase } from "@/lib/patent-watch/managed-request-db";
import { configuredManagedWebWatch, webManagedWatch } from "@/lib/patent-watch/managed-web-watch";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const POST = withOwnerRoute(async (request: Request, context: { params: Promise<{ caseId: string; runId: string }> }) => {
  try {
    const p = await context.params, caseId = managedCaseId(p.caseId), runId = managedRequestId(p.runId);
    const raw = await managedJson(request, 1024);
    const input = managedRequestInput(() => z.object({ action: z.enum(["start", "reconcile"]) }).strict().parse(raw));
    // Reject query overrides and mismatched DB bindings before creating a Client.
    await configuredManagedWebWatch();
    return await withManagedDeliveryDatabase(async (db, deadline) => Response.json(await webManagedWatch(db, caseId, runId, input.action, deadline)));
  } catch (e) { return managedApiError(e); }
});
