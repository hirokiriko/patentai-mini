import { Client } from "pg";
import { TrialError } from "./policy";
import { guardOperatorDatabase,type DatabaseAccess } from "./operator-access";
import { DatabasePermit,databasePermitReader,guardDatabasePermit } from "./database-permit";

// One Local session process, including failed connection attempts. There is no
// public reset: another invocation cannot replenish its connection allowance.
let connectionAttempts=0;

/** Shared connection entry for the fixed operator target and reviewed bootstrap
 * target. The caller must bind host/database/user to its approved manifest;
 * passing an administrator URL never authorizes administrator SQL. */
export async function connectPermitDatabase(target:{url:string;host:string;database:string;user:string;catalogOnly?:true},
  access:DatabaseAccess,credential:{getToken:()=>Promise<{token:string}>}){
  // node-postgres otherwise inherits PGOPTIONS and PGREPLICATION. Do not let
  // ambient connection modes alter this fixed session, including via a future
  // driver that starts reading libpq service configuration.
  const forbidden=new Set(["PGOPTIONS","PGREPLICATION","PGSERVICE"]);
  if(Object.entries(process.env).some(([key,value])=>value!==undefined&&forbidden.has(key.toUpperCase())))
    throw new TrialError("trial_database_environment_invalid");
  const url=new URL(target.url);
  if(url.protocol!=="postgresql:"||url.hostname!==target.host||Number(url.port||5432)!==5432||
    decodeURIComponent(url.pathname.slice(1))!==target.database||decodeURIComponent(url.username)!==target.user||
    !url.password||url.search||url.hash)throw new TrialError("trial_database_target_invalid");
  if(connectionAttempts>=20)throw new TrialError("trial_database_connection_limit");
  connectionAttempts++;
  const client=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,servername:target.host},connectionTimeoutMillis:5000,
    statement_timeout:1000,query_timeout:1500,lock_timeout:500,idle_in_transaction_session_timeout:9000,application_name:"trial-local-operator",
    ...(target.catalogOnly?{options:"-c search_path=pg_catalog -c default_transaction_read_only=on"}:{})});
  client.on("error",()=>undefined);
  const detach=guardOperatorDatabase(client,access);
  const permit=new DatabasePermit(access,databasePermitReader(access,credential),()=>client.end());
  guardDatabasePermit(client,permit);
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{permit.dispose();detach();await client.end().catch(()=>undefined);})();
  try{
    await permit.refresh();permit.assertSend();await client.connect();
    // pg_settings reports these three settings in milliseconds; verify what
    // the server actually accepted before returning any business SQL client.
    const row=(await client.query("select current_database() as db,current_user as usr,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls,"+
      "(select setting::int from pg_settings where name='statement_timeout') as statement_timeout_ms,"+
      "(select setting::int from pg_settings where name='lock_timeout') as lock_timeout_ms,"+
      "(select setting::int from pg_settings where name='idle_in_transaction_session_timeout') as idle_transaction_timeout_ms"+
      (target.catalogOnly?",current_setting('search_path') as catalog_search_path,current_setting('default_transaction_read_only') as catalog_readonly":""))).rows[0];
    if(row?.db!==target.database||row.usr!==target.user||row.tls!==true||row.statement_timeout_ms!==1000||
      row.lock_timeout_ms!==500||row.idle_transaction_timeout_ms!==9000||
      (target.catalogOnly&&(row.catalog_search_path!=="pg_catalog"||row.catalog_readonly!=="on")))throw new TrialError("trial_database_identity_invalid");
    return{client,close};
  }catch{await close();throw new TrialError("trial_database_connection_unconfirmed");}
}
