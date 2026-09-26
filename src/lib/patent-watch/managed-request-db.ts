import { performance } from "node:perf_hooks";
import { Client, type QueryConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import { ManagedWatchError } from "./managed-types";

/** Dedicated connection: server-side cancellation, including locks and COMMIT.
 * An expired write is left unknown; no Promise.race leaves a background query. */
export function managedDeadlineDatabase(client:Client,milliseconds:number){
  const until=performance.now()+milliseconds;
  let pending:Promise<unknown>=Promise.resolve();
  const query=client.query.bind(client);
  const bounded=new Proxy(client,{get(target,key){
    if(key!=="query"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}
    return (config:QueryConfig|string,values?:unknown[])=>{
      const run=async()=>{
        const text=typeof config==="string"?config:config.text,rollback=/^rollback(?:\s|$)/i.test(text);
        if(rollback){const cancel:QueryConfig&{query_timeout:number}={text,values,query_timeout:5000};return query(cancel);}
        const remaining=Math.floor(until-performance.now());
        if(remaining<=0)throw new ManagedWatchError("expired");
        const timeout=Math.max(1,Math.min(remaining,20_000));
        // Numeric constants only; no untrusted identifiers or SQL are interpolated.
        const setting:QueryConfig&{query_timeout:number}={text:`set statement_timeout = ${timeout}; set lock_timeout = ${Math.min(timeout,5000)}`,query_timeout:Math.max(1,Math.min(remaining,21_000))};
        await query(setting);
        const after=Math.floor(until-performance.now());if(after<=0)throw new ManagedWatchError("expired");
        const queryTimeout=Math.max(1,Math.min(after,timeout+1000));
        const boundedConfig:QueryConfig&{query_timeout:number}=typeof config==="string"?{text:config,values,query_timeout:queryTimeout}:{...config,query_timeout:queryTimeout};
        return query(boundedConfig,values);
      };
      const next=pending.then(run,run);pending=next.catch(()=>undefined);return next;
    };
  }});
  return drizzle(bounded,{schema});
}
export async function withManagedDeliveryDatabase<T>(operation:(db:ReturnType<typeof managedDeadlineDatabase>,deadline:AbortSignal)=>Promise<T>,milliseconds=90_000):Promise<T>{
  if(!Number.isInteger(milliseconds)||milliseconds<1000||milliseconds>90_000)throw new ManagedWatchError("unavailable");
  const connectionString=process.env.DATABASE_URL;if(!connectionString)throw new ManagedWatchError("unavailable");
  const deadline=AbortSignal.timeout(milliseconds),started=performance.now();
  const client=new Client({connectionString,connectionTimeoutMillis:5000,statement_timeout:20_000,query_timeout:21_000,lock_timeout:5000,
    idle_in_transaction_session_timeout:30_000,application_name:"managed-delivery-request"});
  client.on("error",()=>undefined);
  let closing:Promise<void>|undefined;
  // Closing this dedicated connection interrupts in-flight client IO at the
  // shared deadline. COMMIT may already have reached PG: reconcile, never resend.
  const timer=setTimeout(()=>{closing=client.end().catch(()=>undefined);},milliseconds);
  try{await client.connect();return await operation(managedDeadlineDatabase(client,milliseconds-(performance.now()-started)),deadline);}
  finally{clearTimeout(timer);await(closing??client.end().catch(()=>undefined));}
}
