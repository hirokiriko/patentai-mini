import { withOwnerRoute } from "@/lib/owner-http";
import { managedApiError,managedCaseId,managedJson,managedRequestInput,managedRequestPeriod } from "@/lib/patent-watch/managed-api";
import { withManagedDeliveryDatabase } from "@/lib/patent-watch/managed-request-db";
import { ManagedWatchRepository } from "@/repositories/managed-watch";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export const POST=withOwnerRoute(async(request:Request,{params}:{params:Promise<{caseId:string}>})=>{
  try{const caseId=managedCaseId((await params).caseId),value=await managedJson(request,1024),period=managedRequestInput(()=>managedRequestPeriod.parse(value));
    return await withManagedDeliveryDatabase(async db=>{
    const run=await new ManagedWatchRepository(db).prepare(caseId,period);
    // Prepared is not accepted or running. Only the fixed operator Job can claim it.
    return Response.json({runId:run.runId,status:"prepared",message:"実行準備を保存しました。実行履歴の開始ボタンから比較できます。"},{status:201});
    });
  }catch(error){return managedApiError(error);}
});
