import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { assertTrialDatabase, readTrialPolicy, requireTrialActive } from "../src/lib/trial/policy";
import { TrialLedger } from "../src/lib/trial/ledger";
import { executeTrialWatch, trialJobRequestSchema, verifyTrialBuild } from "../src/lib/trial/job";
import { inspectManagedCloudDatabase } from "../src/lib/patent-watch/managed-cloud-db";

export async function trialWorker() {
  const p=readTrialPolicy();requireTrialActive(p);await verifyTrialBuild(p);
  if(process.argv.length!==2||process.env.TRIAL_RUNTIME_ROLE!=="worker"||process.env.AI_PROVIDER!=="azure")throw Error();
  assertTrialDatabase(p,process.env.DATABASE_URL,"worker");
  const raw=process.env.TRIAL_EXECUTION_JSON,execution=process.env.CONTAINER_APP_JOB_EXECUTION_NAME;
  const name=p.jobResourceId.split("/").pop()!;
  if(!raw||raw.length>4096||!execution||!execution.startsWith(name+"-")||process.env.CONTAINER_APP_JOB_NAME!==name)throw Error();
  const request=trialJobRequestSchema.parse(JSON.parse(raw));delete process.env.TRIAL_EXECUTION_JSON;
  const url=new URL(process.env.DATABASE_URL!);url.search="";
  const client=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,servername:p.database.host},
    connectionTimeoutMillis:15_000,statement_timeout:30_000,query_timeout:35_000,lock_timeout:5000,
    idle_in_transaction_session_timeout:30_000,options:"-c search_path=pg_catalog,public",application_name:"trial-watch-worker"});
  client.on("error",()=>undefined);
  try {
    await client.connect();await inspectManagedCloudDatabase(client,{host:p.database.host,port:5432,database:p.database.database,user:p.database.workerUser});
    await executeTrialWatch(new ManagedWatchRepository(drizzle(client,{schema})),request,execution,TrialLedger.configured());
  }finally{await client.end().catch(()=>undefined);}
}
if(require.main===module){
  const watchdog=setTimeout(()=>{process.stdout.write('{"status":"reconciliation_required"}\n');process.exit(2);},29*60_000);
  void trialWorker().then(()=>{process.stdout.write('{"status":"completed"}\n');},()=>{
    process.stdout.write('{"status":"reconciliation_required"}\n');process.exitCode=2;
  }).finally(()=>clearTimeout(watchdog));
}
