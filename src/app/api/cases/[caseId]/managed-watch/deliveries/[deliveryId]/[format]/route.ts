import { z } from "zod";
import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError,managedCaseId,managedDeliveryRepository,managedRequestId,managedRequestInput } from "@/lib/patent-watch/managed-api";
import { ManagedPrivateStorage,validateManagedArtifactManifest } from "@/lib/patent-watch/managed-storage";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=withOwnerRoute(async(_request:Request,{params}:{params:Promise<{caseId:string;deliveryId:string;format:string}>})=>{
  try{const p=await params,caseId=managedCaseId(p.caseId),id=managedRequestId(p.deliveryId),format=managedRequestInput(()=>z.enum(["pdf","csv"]).parse(p.format));
    const saved=await managedDeliveryRepository().get(caseId,id);
    if(saved.status!=="stored")return Response.json({error:"delivery_not_ready"},{status:409});
    const manifest=validateManagedArtifactManifest(saved.manifest,caseId,id),bytes=await ManagedPrivateStorage.configured().read(manifest,format);
    return new Response(new Uint8Array(bytes),{headers:{"Content-Type":format==="pdf"?"application/pdf":"text/csv; charset=utf-8",
      "Content-Disposition":`attachment; filename="watch-${caseId}-v${saved.report.version}.${format}"`}});
  }catch(error){return managedApiError(error);}
});
