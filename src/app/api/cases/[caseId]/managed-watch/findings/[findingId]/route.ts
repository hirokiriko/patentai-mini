import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError,managedCaseId,managedJson,managedRequestInput } from "@/lib/patent-watch/managed-api";
import { withManagedDeliveryDatabase } from "@/lib/patent-watch/managed-request-db";
import { ManagedWatchRepository } from "@/repositories/managed-watch";
export const dynamic="force-dynamic";
export const GET=withOwnerRoute(async(_request:Request,{params}:{params:Promise<{caseId:string;findingId:string}>})=>{
  try{const p=await params,caseId=managedCaseId(p.caseId),findingId=managedCaseId(p.findingId);return await withManagedDeliveryDatabase(async db=>Response.json(await new ManagedWatchRepository(db).findingReview(caseId,findingId)),20_000);}
  catch(error){return managedApiError(error);}
});
export const PATCH=withOwnerRoute(async(request:Request,{params}:{params:Promise<{caseId:string;findingId:string}>})=>{
  try{const p=await params,caseId=managedCaseId(p.caseId),findingId=managedCaseId(p.findingId),value=await managedJson(request,1024),body=managedRequestInput(()=>z.object({reviewed:z.boolean(),expectedVersion:z.number().int().nonnegative().max(2147483646)}).strict().parse(value));
    return await withManagedDeliveryDatabase(async db=>{await new ManagedWatchRepository(db).reviewFinding(caseId,findingId,body.reviewed,body.expectedVersion);return Response.json({saved:true});},20_000);
  }catch(error){return managedApiError(error);}
});
