import { cloudFixture } from "./koho-cloud-import-fixtures";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { projectManagedPackage } from "../src/lib/koho-import/managed-package";
import { cloudManifestName, sha256, type CloudConfiguration, type CloudManifest } from "../src/lib/koho-import/cloud-config";
import { managedBudgetPolicyFixture } from "../src/lib/patent-watch/managed-budget-policy.test-support";
import { managedBudgetTargetDigest } from "../src/lib/patent-watch/managed-budget-policy";
import { managedBudgetBindingSchema } from "../src/lib/patent-watch/managed-budget-contract";
import { managedImportBudgetRequest } from "../src/lib/patent-watch/managed-execution-budget";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";
export async function managedCloudImportFixture() {
  const f = await cloudFixture({ issue: "2026-148", publicationDate: "2026-08-12" });
  const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "buffer", bytes: f.data }, limits: buildKohoManualImportLimits(f.data.length) });
  const managed = projectManagedPackage(parsed, f.plan);
  const config: Extract<CloudConfiguration,{approval:"STANDARD_MANAGED_WATCH_RELEASE_V1"}> = { ...f.config, approval: "STANDARD_MANAGED_WATCH_RELEASE_V1" };
  const manifest: CloudManifest = { ...f.manifest, approval: config.approval, expiresAt:new Date(Date.now()+3*60*60_000).toISOString(), packages: f.manifest.packages.map(p => ({ ...p, packageType: "JPA", managedSourcesSha256: managed.managedSourcesSha256, managedReceiptSha256: managed.managedReceiptSha256 })),
    releaseReservation: { packageCount: 1, compressedBytes: f.data.length, jobExecutions: 1, jobMinutes: 120, ledgerDigest: "f".repeat(64), additionalForecastYen: 30_000, monthlyForecastYen: 20_000 } };
  async function publish() {
    const bytes = Buffer.from(JSON.stringify(manifest)), name = cloudManifestName(config), old = f.blob.objects.get(name)!;
    const etag = await f.blob.replace(name, bytes, old.etag); config.manifest = { byteLength: bytes.length, sha256: sha256(bytes), etag };
  }
  const job={resourceId:config.expectedEnvironmentResourceId.replace("/managedEnvironments/fictional","/jobs/fictional-manual"),name:"fictional-manual",
    image:`fictional.azurecr.io/patentai-mini@sha256:${"b".repeat(64)}`,databaseSecretRef:"fictional-import"};
  function bindBudget(){
    const {policy}=managedBudgetPolicyFixture();
    Object.assign(policy.targets,{jobResourceId:job.resourceId,environmentResourceId:config.expectedEnvironmentResourceId,
      storageAccount:config.storageAccount,container:config.container,managedIdentityClientId:config.managedIdentityClientId??null,
      importTarget:config.expectedTarget,watchTarget:{...config.expectedTarget,user:"fictional_app"},importDatabaseSecretRef:job.databaseSecretRef});
    policy.codeSha=config.expectedCodeSha;policy.image=job.image;
    const binding=managedBudgetBindingSchema.parse({storageAccount:config.storageAccount,container:config.container,targetBindingHash:managedBudgetTargetDigest(policy.targets),
      ownerBindingHash:policy.targets.ownerBindingHash,...(config.managedIdentityClientId?{managedIdentityClientId:config.managedIdentityClientId}:{})});
    const pricingDigest=sha256(JSON.stringify(policy)),request=managedImportBudgetRequest(config,manifest,job,policy,binding,pricingDigest,null);
    config.budgetBinding=binding;config.serviceBudget={serviceKey:policy.serviceKey,requestDigest:request.requestDigest,profileDigest:null,pricingDigest};
    const budget={async verify(c:CloudConfiguration,m:CloudManifest){
      const actual=managedImportBudgetRequest(c,m,job,policy,binding,pricingDigest,null);
      if(managedDigest(actual)!==managedDigest(request))throw Error("fictional_budget_mismatch");
      return{expiresAt:m.expiresAt,remainingMs:Date.parse(m.expiresAt)-Date.now()};
    }};
    return{budget,policy,binding,pricingDigest,request};
  }
  await publish();const budgeted=bindBudget();return { ...f, config, manifest, managed, publish,job,bindBudget,...budgeted };
}
