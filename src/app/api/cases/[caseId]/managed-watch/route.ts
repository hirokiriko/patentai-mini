import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError,managedCaseId,managedDeliveryRepository,managedJson,managedWatchRepository } from "@/lib/patent-watch/managed-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{caseId:string}>};
export const GET=withOwnerRoute(async(_request:Request,{params}:Context)=>{
  try{const caseId=managedCaseId((await params).caseId),repository=managedWatchRepository();
    const setting=await repository.setting(caseId);
    return Response.json({setting:setting?{caseId,contractSignedOn:setting.contractSignedOn,monitoringStartsOn:setting.monitoringStartsOn,
      contractEndsOn:setting.contractEndsOn,enabled:setting.enabled,publicationNumber:setting.base.publicationNumber,version:setting.base.version,selectedClaimNos:setting.selectedClaimNos}:null,
      runs:await repository.history(caseId),deliveries:await managedDeliveryRepository().list(caseId)});
  }catch(error){return managedApiError(error);}
});
export const PUT=withOwnerRoute(async(request:Request,{params}:Context)=>{
  try{const caseId=managedCaseId((await params).caseId),value=await managedJson(request);
    if(!value||typeof value!=="object"||("caseId" in value && value.caseId!==caseId))return Response.json({error:"invalid_setting"},{status:400});
    await managedWatchRepository().saveSetting({...value,caseId});return Response.json({saved:true});
  }catch(error){return managedApiError(error);}
});
