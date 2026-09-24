import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError, managedCaseId, managedJson,managedRequestInput,managedRequestPeriod,managedRequestDate } from "@/lib/patent-watch/managed-api";
import { withManagedDeliveryDatabase } from "@/lib/patent-watch/managed-request-db";
import { ManagedDeliveryRepository } from "@/repositories/managed-delivery";
import { managedHash } from "@/lib/patent-watch/managed-types";
import { ManagedPrivateStorage, createManagedDelivery } from "@/lib/patent-watch/managed-storage";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
const input=z.object({deliveryId:z.uuidv4(),period:managedRequestPeriod,distributionTableSha256:managedHash,
  reason:z.enum(["initial","late_publication","correction","review_update"]),deliveredOn:managedRequestDate.nullable()}).strict();
export const POST=withOwnerRoute(async(request:Request,{params}:{params:Promise<{caseId:string}>})=>{
  try{
    const caseId=managedCaseId((await params).caseId),value=await managedJson(request,2048),body=managedRequestInput(()=>input.parse(value));
    return await withManagedDeliveryDatabase(async(db,deadline)=>{
    const repository=new ManagedDeliveryRepository(db);
    const report=await createManagedDelivery(repository,ManagedPrivateStorage.configured(deadline),{kind:"delivery",caseId,...body},deadline);
    return Response.json({status:"stored",deliveryId:report.deliveryId,version:report.version,complete:report.coverage.complete},{status:201});
    });
  }catch(error){return managedApiError(error);}
});
