import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError, managedCaseId } from "@/lib/patent-watch/managed-api";
import { withManagedDeliveryDatabase } from "@/lib/patent-watch/managed-request-db";
import { ManagedDeliveryRepository } from "@/repositories/managed-delivery";
import { ManagedWatchRepository } from "@/repositories/managed-watch";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const POST=withOwnerRoute(async(_request:Request,{params}:{params:Promise<{caseId:string}>})=>{
  try{const caseId=managedCaseId((await params).caseId);
    return await withManagedDeliveryDatabase(async db=>{
      if(!await new ManagedWatchRepository(db).setting(caseId))return Response.json({error:"not_found"},{status:404});
      return Response.json(await new ManagedDeliveryRepository(db).acquireDistribution());
    });
  }catch(error){return managedApiError(error);}
});
