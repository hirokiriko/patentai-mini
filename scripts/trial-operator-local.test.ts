import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { OperatorAccess, guardOperatorDatabase, operatorPolicyBinding, operatorTicketDigest, type OperatorTicket } from "../src/lib/trial/operator-access";
import { trialFixture } from "../src/lib/trial/policy.test-support";
import { TRIAL_START } from "../src/lib/trial/policy";

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1")("operator isolated PG16 deadline", () => {
  let env: Awaited<ReturnType<typeof isolatedPg16>>;
  beforeAll(async () => { env = await isolatedPg16(129); }, 120000);
  afterAll(async () => { await env?.cleanup(); }, 60000);
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
