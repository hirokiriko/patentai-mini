import { Client } from "pg";
import { TrialError } from "./policy";
import { guardOperatorDatabase,type OperatorAccess } from "./operator-access";
import { DatabasePermit,databasePermitReader,guardDatabasePermit } from "./database-permit";

/** Shared connection entry for the fixed operator target and reviewed bootstrap
 * target. The caller must bind host/database/user to its approved manifest;
 * passing an administrator URL never authorizes administrator SQL. */
export async function connectPermitDatabase(target:{url:string;host:string;database:string;user:string},
  access:OperatorAccess,credential:{getToken:()=>Promise<{token:string}>}){
  const url=new URL(target.url);
  if(url.protocol!=="postgresql:"||url.hostname!==target.host||Number(url.port||5432)!==5432||
    decodeURIComponent(url.pathname.slice(1))!==target.database||decodeURIComponent(url.username)!==target.user||
    !url.password||url.search||url.hash)throw new TrialError("trial_database_target_invalid");
  const client=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,servername:target.host},connectionTimeoutMillis:5000,
    statement_timeout:1000,query_timeout:1500,lock_timeout:500,idle_in_transaction_session_timeout:9000,application_name:"trial-local-operator"});
  client.on("error",()=>undefined);
  const detach=guardOperatorDatabase(client,access);
  const permit=new DatabasePermit(access,databasePermitReader(access,credential),()=>client.end());
  guardDatabasePermit(client,permit);
  const close=async()=>{permit.dispose();detach();await client.end().catch(()=>undefined);};
  try{
    await permit.refresh();permit.assertSend();await client.connect();
    const row=(await client.query("select current_database() as db,current_user as usr,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls")).rows[0];
    if(row.db!==target.database||row.usr!==target.user||row.tls!==true)throw new TrialError("trial_database_identity_invalid");
    return{client,close};
  }catch{await close();throw new TrialError("trial_database_connection_unconfirmed");}
}
