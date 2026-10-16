import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { OperatorAccess, guardOperatorDatabase, operatorPolicyBinding, operatorTicketDigest, type OperatorTicket } from "../src/lib/trial/operator-access";
import { trialFixture } from "../src/lib/trial/policy.test-support";
import { TRIAL_START } from "../src/lib/trial/policy";
import { DatabasePermit,guardDatabasePermit } from "../src/lib/trial/database-permit";
import { Client } from "pg";

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1")("operator isolated PG16 deadline", () => {
  let env: Awaited<ReturnType<typeof isolatedPg16>>;
  beforeAll(async () => { env = await isolatedPg16(129); }, 120000);
  afterAll(async () => { await env?.cleanup(); }, 60000);
  it("bounds server execution to one second and rejects COMMIT after guardian withdrawal",async()=>{
    const p=structuredClone(trialFixture),start=Date.parse(TRIAL_START),began=performance.now(),id="11111111-1111-4111-8111-111111111111";
    const now=()=>start+1000+performance.now()-began;
    const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),packages:[],samples:[],artifacts:[],
      databaseWindow:{lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fixture",ruleId:`/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/guard`,
        journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:new Date(start).toISOString(),useUntil:new Date(start+600000).toISOString()}};
    p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:"b".repeat(64)};
    const access=new OperatorAccess(ticket,p,{utc:now,monotonic:()=>performance.now()-began});let alive=true;
    const read=async()=>({binding_digest:"a".repeat(64),lifecycle_id:id,rule_id:ticket.databaseWindow!.ruleId,
      cleanup_strategy:"single_job",status:"active",usage_allowed:alive,close_requested:false,blocked:null,
      cloud_guard:{nonce:"fixture",job_started_at:ticket.databaseWindow!.jobStartedAt},cleanup_at:ticket.databaseWindow!.useUntil,
      use_lease_from:new Date(now()).toISOString(),use_lease_until:new Date(now()+10000).toISOString()});
    const permit=new DatabasePermit(access,read,()=>env.reportClient.end());
    const detach=guardOperatorDatabase(env.reportClient,access);guardDatabasePermit(env.reportClient,permit);
    try{
      await env.reportClient.query("SET statement_timeout=1000");
      await expect(env.reportClient.query("select pg_sleep(2)")).rejects.toThrow(/statement timeout/);
      // Unknown SQL must poison that client; withdrawal uses a fresh isolated
      // connection, never a statement queued behind the timed-out request.
      const fresh=new Client({...env.connection,ssl:false,statement_timeout:1000,query_timeout:1500});fresh.on("error",()=>undefined);
      const freshPermit=new DatabasePermit(access,read,()=>fresh.end());
      const freshDetach=guardOperatorDatabase(fresh,access);guardDatabasePermit(fresh,freshPermit);
      try{await fresh.connect();await fresh.query("BEGIN");alive=false;
        await expect(fresh.query("COMMIT")).rejects.toThrow("trial_database_permit_unavailable");}
      finally{freshPermit.dispose();freshDetach();await fresh.end().catch(()=>undefined);}
    }finally{permit.dispose();detach();access.dispose();await env.reportClient.end().catch(()=>undefined);}
  });
  it("rejects COMMIT after an awaited insert and rolls back on connection closure", async () => {
    const p = structuredClone(trialFixture), start = Date.parse(TRIAL_START);
    let now = start + 1000;
    const ticket: OperatorTicket = {schema:1,id:"11111111-1111-4111-8111-111111111111",policyDigest:operatorPolicyBinding(p),
      startsAt:new Date(start).toISOString(),endsAt:new Date(start+3_600_000).toISOString(),packages:[],samples:[],artifacts:[]};
    p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:"a".repeat(64)};
    const access = new OperatorAccess(ticket,p,{utc:()=>now,monotonic:()=>now-start});
    const detach = guardOperatorDatabase(env.watchClient,access);
    try {
      await env.watchClient.query("BEGIN");
      await env.watchClient.query("insert into cases(title) values($1)",["FICTIONAL EXPIRED OPERATOR"]);
      now = start + 3_600_000;
      expect(() => env.watchClient.query("COMMIT")).toThrow("trial_operator_access_expired");
      await env.watchClient.end();
      expect((await env.sql("select count(*)::int as n from cases where title=$1",["FICTIONAL EXPIRED OPERATOR"]))[0].n).toBe(0);
    } finally { detach(); access.dispose(); }
  });
});
