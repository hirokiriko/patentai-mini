import { and, eq, inArray, or, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { managedDigest } from "../lib/patent-watch/managed-claims";
import { managedCloudConfigSchema, parseManagedCloudConfiguration, type ManagedCloudConfiguration } from "../lib/patent-watch/managed-cloud-config";
import { ManagedWatchError } from "../lib/patent-watch/managed-types";
type Database = NodePgDatabase<typeof schema>;
const J = schema.managedWatchJobStarts, R = schema.managedWatchRuns;
const check = (value: unknown) => { if (!value) throw new ManagedWatchError("conflict"); };
/** A small release-specific start ledger, independent of deleted customer rows. */
export class ManagedCloudStartRepository {
  constructor(private readonly database: Database) {}
  async reserve(value: unknown) {
    const config = parseManagedCloudConfiguration(value);
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(129129::bigint)`);
      const previous = await tx.select().from(J).limit(25); check(previous.length < 24);
      const previousConfigs = previous.map(row => {
        const config = managedCloudConfigSchema.parse(JSON.parse(row.configJson)); check(managedDigest(config) === row.configDigest); return config;
      });
      const cases = new Set([...previousConfigs.flatMap(c=>c.caseAllowList), ...config.caseAllowList]); check(cases.size <= 5);
      const proof = config.budgetProof;
      for (const c of previousConfigs) for (const field of ["externalJobExecutions", "externalJobReservedMinutes", "externalNormalSends", "externalFastSends"] as const)
        check(proof[field] >= c.budgetProof[field]);
      check(previous.length + proof.externalJobExecutions + 1 <= 24);
      check(previous.reduce((n,r)=>n+r.logicalStarts,0) + config.runs.length <= 40);
      check(previous.reduce((n,r)=>n+r.reservedMinutes,0) + proof.externalJobReservedMinutes + 95 <= 48*60);
      check(previous.reduce((n,r)=>n+r.reservedNormal,0) + proof.externalNormalSends + config.runs.length*41 <= 900);
      for (const input of config.runs) {
        const [run] = await tx.select().from(R).where(and(eq(R.runId,input.runId),eq(R.caseId,input.caseId))).for("update");
        check(run && run.status === "prepared" && run.startReservationId === null && run.snapshotDigest === input.snapshotDigest);
        await tx.update(R).set({ startReservationId: config.operationId }).where(eq(R.runId,input.runId));
      }
      await tx.insert(J).values({ operationId:config.operationId, configJson:JSON.stringify(config), configDigest:managedDigest(config),
        logicalStarts:config.runs.length, reservedNormal:config.runs.length*41, reservedMinutes:95, status:"reserved" });
      return config;
    });
  }
  async submitting(config: ManagedCloudConfiguration) {
    const rows = await this.database.update(J).set({status:"submitting"}).where(and(eq(J.operationId,config.operationId),eq(J.configDigest,managedDigest(config)),eq(J.status,"reserved"))).returning();
    check(rows.length===1);
  }
  async get(operationId:string) {
    const [row] = await this.database.select().from(J).where(eq(J.operationId,operationId)); if(!row)throw new ManagedWatchError("not_found");
    const config=managedCloudConfigSchema.parse(JSON.parse(row.configJson)); check(managedDigest(config)===row.configDigest);
    const runs=await this.database.select({runId:R.runId,caseId:R.caseId,status:R.status,executionId:R.executionId,consumedNormal:R.consumedNormal})
      .from(R).where(eq(R.startReservationId,operationId));
    return {config,status:row.status,executionId:row.executionId,runs};
  }
  async recordExecution(config:ManagedCloudConfiguration,executionId:string) {
    check(/^[a-z0-9-]{1,100}$/.test(executionId)&&executionId.startsWith(config.jobName+"-"));
    const rows=await this.database.update(J).set({executionId}).where(and(eq(J.operationId,config.operationId),eq(J.configDigest,managedDigest(config)),
      or(isNull(J.executionId),eq(J.executionId,executionId)))).returning({id:J.operationId});check(rows.length===1);
  }
  async finish(config:ManagedCloudConfiguration,executionId:string) {
    return this.database.transaction(async tx=>{
      const [row]=await tx.select().from(J).where(eq(J.operationId,config.operationId)).for("update");
      check(row && row.configDigest===managedDigest(config) && row.executionId===executionId && ["accepted","unknown"].includes(row.status));
      const runs=await tx.select({runId:R.runId,status:R.status,consumed:R.consumedNormal,executionId:R.executionId}).from(R).where(eq(R.startReservationId,config.operationId));
      const complete=runs.length===config.runs.length&&runs.every(r=>r.status==="completed"&&r.executionId===executionId);
      await tx.update(J).set({status:complete?"completed":"unknown",...(complete?{reservedNormal:runs.reduce((n,r)=>n+r.consumed,0)}:{})}).where(eq(J.operationId,config.operationId));
      return complete;
    });
  }
  async markUnknown(config:ManagedCloudConfiguration) {
    // Never downgrade a worker that has already completed after a lost HTTP ACK.
    await this.database.update(J).set({status:"unknown"}).where(and(eq(J.operationId,config.operationId),eq(J.configDigest,managedDigest(config)),inArray(J.status,["reserved","submitting"])));
  }
}
