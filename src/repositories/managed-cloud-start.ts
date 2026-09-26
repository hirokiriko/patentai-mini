import { and, eq, inArray, or, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { managedDigest } from "../lib/patent-watch/managed-claims";
import { managedCloudConfigSchema, parseManagedCloudStartConfiguration, type ManagedCloudConfiguration } from "../lib/patent-watch/managed-cloud-config";
import { ManagedWatchError, isUnchangedManagedSnapshot } from "../lib/patent-watch/managed-types";
import { readManagedStoredRun } from "./managed-watch";
type Database = NodePgDatabase<typeof schema>;
const J = schema.managedWatchJobStarts, R = schema.managedWatchRuns;
const check = (value: unknown) => { if (!value) throw new ManagedWatchError("conflict"); };
/** Finite business execution history, independent of deleted customer rows.
 * Shared Blob accounting separately gates money and combined watch/import use. */
export class ManagedCloudStartRepository {
  constructor(private readonly database: Database) {}
  async reserve(value: unknown) {
    const config = parseManagedCloudStartConfiguration(value);
    const normal = config.runs.filter(r => r.mode !== "no_change_only").length * 41;
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(129129::bigint)`);
      const previous = await tx.select().from(J).limit(1001); check(previous.length < 1000);
      const previousConfigs = previous.map(row => {
        const config = managedCloudConfigSchema.parse(JSON.parse(row.configJson)); check(managedDigest(config) === row.configDigest); return config;
      });
      if (config.approval === "STANDARD_MANAGED_WATCH_RELEASE_V1") {
        const cases = new Set([...previousConfigs.filter(c => c.approval === "STANDARD_MANAGED_WATCH_RELEASE_V1")
          .flatMap(c => c.caseAllowList), ...config.caseAllowList]); check(cases.size <= 5);
        const release = previous.filter((_r,i) => previousConfigs[i].approval === "STANDARD_MANAGED_WATCH_RELEASE_V1");
        check(release.length + 1 <= 24);
        check(release.reduce((n,r)=>n+r.logicalStarts,0) + config.runs.length <= 40);
        check(release.reduce((n,r)=>n+r.reservedMinutes,0) + 95 <= 48*60);
        check(release.reduce((n,r)=>n+r.reservedNormal,0) + normal <= 900);
      }
      for (const input of config.runs) {
        const [run] = await tx.select().from(R).where(and(eq(R.runId,input.runId),eq(R.caseId,input.caseId))).for("update");
        check(run && run.status === "prepared" && run.startReservationId === null && run.snapshotDigest === input.snapshotDigest);
        const validated = readManagedStoredRun(run);
        if (input.mode === "no_change_only") check(isUnchangedManagedSnapshot(validated.snapshot));
        await tx.update(R).set({ startReservationId: config.operationId }).where(eq(R.runId,input.runId));
      }
      await tx.insert(J).values({ operationId:config.operationId, configJson:JSON.stringify(config), configDigest:managedDigest(config),
        // This existing DB column records the 95-minute worker bound. The shared
        // service ledger separately reserves the full 120-minute Job allocation.
        logicalStarts:config.runs.length, reservedNormal:normal, reservedMinutes:95, status:"reserved" });
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
