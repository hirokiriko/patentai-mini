import { readFile } from "node:fs/promises";
import { parseManagedCloudStartConfiguration } from "../src/lib/patent-watch/managed-cloud-config";
import { openManagedCloudDatabase } from "../src/lib/patent-watch/managed-cloud-db";
import { executeManagedRun, managedAzureAnalysis } from "../src/lib/patent-watch/managed-service";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { ManagedCloudStartRepository } from "../src/repositories/managed-cloud-start";
import { ManagedServiceBudgetStorage } from "../src/lib/patent-watch/managed-service-budget-storage";
import { managedBudgetBindingFromEnvironment } from "../src/lib/patent-watch/managed-budget-contract";
import { cloudManagedIdentity } from "../src/lib/koho-import/cloud-blob";

/** Fixed awaited worker; an OS/Job restart does not replay a claimed run. */
if(require.main===module){
  let printed=false;
  const unknown=()=>{if(!printed){printed=true;process.stdout.write('{"status":"reconciliation_required"}\n');}};
  const stop=()=>{unknown();process.exit(2);};
  const watchdog=setTimeout(stop,95*60_000);let budgetDeadline:ReturnType<typeof setTimeout>|undefined;process.on("SIGTERM",stop);process.on("SIGINT",stop);
  void(async()=>{
    let connection:Awaited<ReturnType<typeof openManagedCloudDatabase>>|undefined;
    try{
      if(process.argv.length!==2||!process.env.MANAGED_WATCH_CONFIG_JSON||Buffer.byteLength(process.env.MANAGED_WATCH_CONFIG_JSON)>32768)throw Error();
      const config=parseManagedCloudStartConfiguration(JSON.parse(process.env.MANAGED_WATCH_CONFIG_JSON),Date.now(),false);
      const password=process.env.MANAGED_WATCH_DATABASE_PASSWORD;
      delete process.env.MANAGED_WATCH_CONFIG_JSON;delete process.env.MANAGED_WATCH_DATABASE_PASSWORD;
      const execution=process.env.CONTAINER_APP_JOB_EXECUTION_NAME;
      if(!password||process.env.CONTAINER_APP_JOB_NAME!==config.jobName||!execution||!execution.startsWith(config.jobName+"-")||!/^[a-z0-9-]{1,100}$/.test(execution)||
        (await readFile(".managed-build-sha","utf8")).trim()!==config.codeSha||process.env.AI_PROVIDER!=="azure"||process.env.AZURE_RESOURCE_NAME!==config.ai.resourceName||
        process.env.AZURE_OPENAI_DEPLOYMENT_NAME!==config.ai.deployment||process.env.AZURE_OPENAI_API_VERSION!==config.ai.apiVersion||!process.env.AZURE_API_KEY||
        process.env.DATABASE_URL||process.env.KOHO_CLOUD_DATABASE_PASSWORD||process.env.AZURE_OPENAI_BASE_URL)throw Error();
      const binding=managedBudgetBindingFromEnvironment();
      const permit=await ManagedServiceBudgetStorage.withIdentity(binding,cloudManagedIdentity(binding)).verifyWatch(config);
      budgetDeadline=setTimeout(stop,permit.remainingMs);
      connection=await openManagedCloudDatabase(config,password);
      const starts=new ManagedCloudStartRepository(connection.database), repository=new ManagedWatchRepository(connection.database);
      const stored=await starts.get(config.operationId);
      if(JSON.stringify(stored.config)!==JSON.stringify(config)||!["submitting","unknown"].includes(stored.status)||(stored.executionId!==null&&stored.executionId!==execution))throw Error();
      try{
        for(const run of config.runs)await executeManagedRun(repository,run.caseId,run.runId,execution,managedAzureAnalysis,{operationId:config.operationId,snapshotDigest:run.snapshotDigest,aiBudget:permit.aiBudget,...(run.mode?{mode:run.mode}:{})});
        if(!await starts.finish(config,execution))throw Error();
      }catch{await starts.finish(config,execution).catch(()=>undefined);throw Error();}
      printed=true;process.stdout.write('{"status":"completed"}\n');process.exitCode=0;
    }catch{unknown();process.exitCode=2;}
    finally{await connection?.client.end().catch(()=>undefined);clearTimeout(watchdog);clearTimeout(budgetDeadline);process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);}
  })();
}
