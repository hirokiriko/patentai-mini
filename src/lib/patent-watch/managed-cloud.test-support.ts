import type { ManagedCloudConfiguration } from "./managed-cloud-config";
export function managedCloudFixture(caseId=7,runId="22222222-2222-4222-8222-222222222222",snapshotDigest="a".repeat(64)):ManagedCloudConfiguration{
  return {approval:"STANDARD_MANAGED_WATCH_RELEASE_V1",operationId:"11111111-1111-4111-8111-111111111111",codeSha:"a".repeat(40),
    image:`fictional.azurecr.io/patentai-mini@sha256:${"b".repeat(64)}`,jobName:"fictional-manual",
    jobResourceId:"/subscriptions/33333333-3333-4333-8333-333333333333/resourceGroups/fictional/providers/Microsoft.App/jobs/fictional-manual",
    target:{host:"fictional.postgres.database.azure.com",port:5432,database:"fictional",user:"fictional_app"},expiresAt:new Date(Date.now()+3*60*60_000).toISOString(),
    caseAllowList:[caseId],runs:[{caseId,runId,snapshotDigest}],ai:{resourceName:"fictional-ai",deployment:"fictional-normal",apiVersion:"2025-04-01-preview"},
    secrets:{database:"fictional-app-db",ai:"fictional-ai-key"},budgetProof:{ledgerDigest:"c".repeat(64),checkedAt:new Date().toISOString(),additionalForecastYen:20_000,
      monthlyForecastYen:15_000,externalJobExecutions:0,externalJobReservedMinutes:0,externalNormalSends:0,externalFastSends:0}};
}
