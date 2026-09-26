import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError, managedCaseId, managedJson,managedRequestInput,managedRequestId } from "@/lib/patent-watch/managed-api";
import { withManagedDeliveryDatabase } from "@/lib/patent-watch/managed-request-db";
import { ManagedDeliveryRepository } from "@/repositories/managed-delivery";
import { ManagedPrivateStorage, reconcileManagedDelivery } from "@/lib/patent-watch/managed-storage";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export const POST=withOwnerRoute(async(request:Request,{params}:{params:Promise<{caseId:string;deliveryId:string}>})=>{
  try{
    const p=await params,caseId=managedCaseId(p.caseId),deliveryId=managedRequestId(p.deliveryId),value=await managedJson(request,1024),body=managedRequestInput(()=>z.object({abandonPartial:z.boolean()}).strict().parse(value));
    return await withManagedDeliveryDatabase(async(db,deadline)=>{
    const status=await reconcileManagedDelivery(new ManagedDeliveryRepository(db),ManagedPrivateStorage.configured(deadline),caseId,deliveryId,body.abandonPartial);
    return Response.json({status});
    });
  }catch(error){return managedApiError(error);}
});
