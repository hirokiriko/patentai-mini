import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { managedBaseDigest, managedScreeningInput, parseManagedSetting, validateManagedSnapshot, ManagedWatchError,
  type ManagedCandidate, type ManagedRun, type ManagedRunSnapshot, type ManagedSetting } from "../lib/patent-watch/managed-types";
import { managedClaimContext, managedDigest, planManagedComparisons, validateManagedClaims, validateManagedComparisons,
  type ManagedComparisonPlan } from "../lib/patent-watch/managed-claims";
import { managedPeriodForPublication, validateManagedPeriod, type PublicationPeriod } from "../lib/patent-watch/managed-period";
import { lexicalOverlapScore, tokenizePatentWatchText } from "../lib/patent-watch/prefilter";
import type { ManagedWatchDispatchJournal } from "../lib/ai-operation-budget";
import { validateManagedDelivery } from "../lib/patent-watch/managed-delivery";
import { managedCloudConfigSchema } from "../lib/patent-watch/managed-cloud-config";
import { readOriginalFile, isScopedOriginalName } from "../lib/blob-storage";
import { parseUploadedOriginalFileMetadata } from "../lib/original-file-metadata";
import { verifyManagedBaseOriginal, MANAGED_BASE_XML_BYTES } from "../lib/patent-watch/managed-base-source";
import { lockManagedCase } from "./managed-case-graph";
import { managedWatchAiBudgetSchema, requireManagedWatchCost, type ManagedWatchAiBudget } from "../lib/patent-watch/managed-watch-cost";

type Database = NodePgDatabase<typeof schema>;
const S = schema.managedWatchSettings, R = schema.managedWatchRuns, D = schema.managedWatchDispatches, F = schema.managedWatchFindings;
const ACTIVE = ["prepared", "running", "unknown"];
// Separate contract-wide lock; corpus selection uses a repeatable-read snapshot.
const LOCK = 129_129;
const RUN_MS = 30 * 60_000;
function requireState(value: unknown, code: ConstructorParameters<typeof ManagedWatchError>[0] = "conflict"): asserts value {
  if (!value) throw new ManagedWatchError(code);
}
function settingFrom(row: typeof S.$inferSelect): ManagedSetting {
  const input = parseManagedSetting({ caseId: row.caseId, contractSignedOn: row.contractSignedOn,
    monitoringStartsOn: row.monitoringStartsOn, contractEndsOn: row.contractEndsOn, enabled: row.enabled,
    base: JSON.parse(row.baseClaimsJson),source:JSON.parse(row.sourceJson), selectedClaimNos: JSON.parse(row.selectedClaimsJson) });
  requireState(input.source.documentId===row.sourceDocumentId,"incomplete");
  requireState(managedBaseDigest(input) === row.baseDigest, "incomplete");
  return { ...input, settingId: row.settingId, baseDigest: row.baseDigest };
}
export function readManagedStoredRun(row: typeof R.$inferSelect): ManagedRun {
  const snapshot: ManagedRunSnapshot = JSON.parse(row.snapshotJson); validateManagedSnapshot(snapshot);
  requireState(managedDigest(snapshot) === row.snapshotDigest && row.caseId === snapshot.setting.caseId &&
    row.sourceDocumentId===snapshot.setting.source.documentId &&
    row.settingId === snapshot.setting.settingId && row.baseDigest === snapshot.setting.baseDigest &&
    row.periodFrom === snapshot.period.from && row.periodTo === snapshot.period.to, "incomplete");
  let plan: ManagedComparisonPlan | null = null;
  if (row.planJson !== null) {
    plan = JSON.parse(row.planJson);
    const selected = new Set(plan!.chunks.map(c => c.candidateId));
    const candidates = snapshot.candidates.filter(c => selected.has(c.candidateId));
    requireState(candidates.length === selected.size && candidates.every(c => c.source), "incomplete");
    const expected = planManagedComparisons(snapshot.setting.base, snapshot.setting.selectedClaimNos,
      candidates.map(c => ({ candidateId: c.candidateId, source: c.source! })));
    requireState(JSON.stringify(plan) === JSON.stringify(expected) && row.planDigest === expected.digest, "incomplete");
    plan = expected;
  } else requireState(row.planDigest === null, "incomplete");
  requireState(["prepared", "running", "completed", "failed", "unknown"].includes(row.status), "incomplete");
  return { runId: row.runId, settingId: row.settingId, caseId: row.caseId, status: row.status as ManagedRun["status"],
    snapshot, snapshotDigest: row.snapshotDigest, plan, consumedNormal: row.consumedNormal,
    executionId: row.executionId, acceptedAt: row.acceptedAt, deadlineAt: row.deadlineAt };
}
const runFrom = readManagedStoredRun;

/** Only the managed tables are writable. Common corpus and old watch meanings stay unchanged. */
export class ManagedWatchRepository {
  constructor(private readonly database: Database,private readonly readOriginal=readOriginalFile) {}
  async setting(caseId: number): Promise<ManagedSetting | null> {
    const [row] = await this.database.select().from(S).where(eq(S.caseId, caseId));
    return row ? settingFrom(row) : null;
  }
  async saveSetting(value: unknown): Promise<ManagedSetting> {
    const input = parseManagedSetting(value), baseDigest = managedBaseDigest(input);
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK}::bigint)`);
      await lockManagedCase(tx,input.caseId);
      const [record] = await tx.select({ caseId: schema.cases.caseId }).from(schema.cases).where(eq(schema.cases.caseId, input.caseId));
      requireState(record, "not_found");
      const P=schema.priorArtDocuments;
      const [original]=await tx.select().from(P).where(and(eq(P.caseId,input.caseId),eq(P.docId,input.source.documentId))).for("update");
      requireState(original&&original.publicationNo===null,"invalid_setting");
      const metadata=parseUploadedOriginalFileMetadata(original.sourceCsvRowJson);
      requireState(metadata&&metadata.originalFileName.toLowerCase().endsWith(".xml")&&metadata.size>0&&metadata.size<=MANAGED_BASE_XML_BYTES&&isScopedOriginalName(metadata.blobName,input.caseId,"prior-art"),"invalid_setting");
      const originalSaved=await this.readOriginal(input.caseId,"prior-art",metadata.blobName);
      requireState(originalSaved.bytes.length===metadata.size&&new TextDecoder("utf-8",{fatal:true}).decode(originalSaved.bytes)===original.claimsText,"invalid_setting");
      try{verifyManagedBaseOriginal(originalSaved.bytes,input.source,input.base);}catch{throw new ManagedWatchError("invalid_setting");}
      const settings = await tx.select().from(S);
      const old = settings.find(s => s.caseId === input.caseId);
      requireState(old || settings.length < 5, "limit");
      const active = await tx.select({ runId: R.runId }).from(R).where(and(eq(R.caseId, input.caseId), inArray(R.status, ACTIVE))).limit(1);
      requireState(!active.length, "in_progress");
      if (old && old.baseDigest !== baseDigest) {
        // Finish the old version while its immutable source context is still active.
        // Otherwise a settings change would hide undelivered results from the next report.
        const past = await tx.select().from(R).where(and(eq(R.settingId, old.settingId), eq(R.baseDigest, old.baseDigest))).limit(1001);
        const results = await tx.select({ findingId: F.findingId }).from(F).where(and(eq(F.settingId, old.settingId), eq(F.baseDigest, old.baseDigest))).limit(20_001);
        const T = schema.managedWatchDeliveries;
        const deliveryRows = await tx.select().from(T).where(and(eq(T.settingId, old.settingId), eq(T.baseDigest, old.baseDigest), eq(T.status, "stored"))).limit(1001);
        requireState(past.length <= 1000 && results.length <= 20_000 && deliveryRows.length <= 1000, "limit");
        const deliveries = deliveryRows.map(row => {
          const report = validateManagedDelivery(JSON.parse(row.snapshotJson));
          requireState(managedDigest(report) === row.snapshotDigest && report.caseId === old.caseId, "incomplete");
          return report;
        }).filter(report => report.coverage.complete);
        requireState(results.every(f => deliveries.some(d => d.findings.some(item => item.findingId === f.findingId))));
        requireState(past.every(run => deliveries.some(d => d.period.from === run.periodFrom && d.period.to === run.periodTo &&
          Date.parse(d.generatedAt) >= Date.parse(run.completedAt ?? run.acceptedAt ?? run.createdAt))));
      }
      const values = { caseId: input.caseId, contractSignedOn: input.contractSignedOn, monitoringStartsOn: input.monitoringStartsOn,
        sourceDocumentId:input.source.documentId,sourceJson:JSON.stringify(input.source),
        contractEndsOn: input.contractEndsOn, enabled: input.enabled, baseClaimsJson: JSON.stringify(input.base),
        selectedClaimsJson: JSON.stringify(input.selectedClaimNos), baseDigest, updatedAt: new Date().toISOString() };
      // Existing periods and results retain their original start date. Correct a wrong start in a new setting/case.
      if (old) requireState(old.monitoringStartsOn === input.monitoringStartsOn);
      const [saved] = old ? await tx.update(S).set(values).where(eq(S.settingId, old.settingId)).returning()
        : await tx.insert(S).values(values).returning();
      return settingFrom(saved);
    });
  }
  async run(caseId: number, runId: string): Promise<ManagedRun> {
    const [row] = await this.database.select().from(R).where(and(eq(R.caseId, caseId), eq(R.runId, runId)));
    requireState(row, "not_found"); return runFrom(row);
  }
  async history(caseId: number) {
    return this.database.select({ runId: R.runId, status: R.status, periodFrom: R.periodFrom, periodTo: R.periodTo,
      createdAt: R.createdAt, acceptedAt: R.acceptedAt, completedAt: R.completedAt, errorCode: R.errorCode, countsJson: R.countsJson })
      .from(R).where(eq(R.caseId, caseId)).orderBy(asc(R.createdAt)).limit(1000);
  }
  async prepare(caseId: number, period: PublicationPeriod): Promise<ManagedRun> {
    validateManagedPeriod(period);
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK}::bigint)`);
      const [row] = await tx.select().from(S).where(eq(S.caseId, caseId)); requireState(row, "not_found");
      const setting = settingFrom(row); requireState(setting.enabled, "invalid_setting");
      const expected = managedPeriodForPublication(setting.monitoringStartsOn, period.to);
      requireState(expected && expected.from === period.from && expected.to === period.to, "invalid_setting");
      const active = await tx.select({ runId: R.runId }).from(R).where(and(eq(R.settingId, setting.settingId), inArray(R.status, ACTIVE))).limit(1);
      requireState(!active.length, "in_progress"); // No five-minute recovery for accepted cloud work.
      const [priorSize]=await tx.select({bytes:sql<string>`coalesce(sum(octet_length(${R.snapshotJson})+coalesce(octet_length(${R.planJson}),0)),0)`})
        .from(R).where(and(eq(R.settingId,setting.settingId),eq(R.baseDigest,setting.baseDigest),eq(R.status,"completed")));
      requireState(Number(priorSize.bytes)<=64*1024**2,"limit");
      const prior = await tx.select().from(R).where(and(eq(R.settingId, setting.settingId), eq(R.baseDigest, setting.baseDigest), eq(R.status, "completed"))).limit(1001);
      requireState(prior.length <= 1000, "limit");
      const priorRuns = prior.map(runFrom);
      requireState(priorRuns.every(run => run.caseId === caseId && run.settingId === setting.settingId && run.snapshot.setting.baseDigest === setting.baseDigest), "incomplete");
      const processed = new Set(priorRuns.flatMap(r => r.snapshot.sourceKeys));
      const tokens = tokenizePatentWatchText(managedClaimContext(setting.base, setting.selectedClaimNos).claims.map(c => c.text).join("\n"));
      requireState(tokens.length, "incomplete");
      const sourceKeys = new Set<string>(), candidates: ManagedCandidate[] = [];
      let after = 0, incompleteDocuments = 0, sourceBytes = 0, populationDocuments = 0;
      const corpus = schema.kohoImportDocuments, imports = schema.kohoImportRuns, claims = schema.managedPublicationClaims;
      for (;;) {
        const sizes=await tx.select({id:corpus.documentId,bytes:sql<string>`octet_length(${corpus.claimsText})+octet_length(${corpus.inventionTitle})+coalesce(octet_length(${corpus.abstractText}),0)+coalesce(octet_length(${claims.claimsJson}),0)`})
          .from(corpus).innerJoin(imports, eq(corpus.importId, imports.importId)).leftJoin(claims, eq(corpus.documentId, claims.documentId))
          .where(sql`${corpus.documentId} > ${after} and ${corpus.publicationDate} >= ${setting.monitoringStartsOn} and ${corpus.publicationDate} <= ${period.to}
            and ${imports.packageType} = 'JPA' and ${corpus.kind} in ('A1','P1')`)
          .orderBy(asc(corpus.documentId)).limit(250);
        if(!sizes.length)break;
        const ids:number[]=[];let batchBytes=0;
        for(const item of sizes){const bytes=Number(item.bytes);requireState(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=16*1024**2,"limit");
          if(batchBytes+bytes>16*1024**2)break;batchBytes+=bytes;ids.push(item.id);}
        requireState(ids.length,"limit");
        const batch=await tx.select({document:{documentId:corpus.documentId,contentSha256:corpus.contentSha256,publicationNumber:corpus.publicationNumber,
          publicationDate:corpus.publicationDate,kind:corpus.kind,claimsText:corpus.claimsText,inventionTitle:corpus.inventionTitle,abstractText:corpus.abstractText,applicationNumber:corpus.applicationNumber},
          packageSha:imports.sourceSha256,metadata:{status:claims.status,contentSha256:claims.contentSha256,sourceSha256:claims.sourceSha256,claimsJson:claims.claimsJson,claimsDigest:claims.claimsDigest}})
          .from(corpus).innerJoin(imports,eq(corpus.importId,imports.importId)).leftJoin(claims,eq(corpus.documentId,claims.documentId)).where(inArray(corpus.documentId,ids)).orderBy(asc(corpus.documentId));
        for (const item of batch) {
          const d = item.document, m = item.metadata; after = d.documentId;
          if (++populationDocuments > 100_000) throw new ManagedWatchError("limit");
          let source: ManagedCandidate["source"] = null;
          if (m) requireState(m.contentSha256 === d.contentSha256 && m.sourceSha256 === item.packageSha, "incomplete");
          if (m?.status === "complete") {
            source = JSON.parse(m.claimsJson!); validateManagedClaims(source!);
            requireState(managedDigest({ schema: 1, source }) === m.claimsDigest && source!.publicationNumber === d.publicationNumber &&
              source!.version === d.kind && source!.claims.map(c => c.text).join("\n\n") === d.claimsText, "incomplete");
          }
          const sourceKey = managedDigest({ publicationNumber: d.publicationNumber, content: d.contentSha256,
            numberedClaims: m?.claimsDigest ?? null, completeness: m?.status ?? "missing" });
          if (sourceKeys.has(sourceKey) || processed.has(sourceKey)) continue;
          sourceKeys.add(sourceKey); if (!source) incompleteDocuments++;
          sourceBytes += Buffer.byteLength(d.claimsText);
          requireState(sourceBytes <= 512 * 1024 ** 2, "limit");
          const lexicalScore = lexicalOverlapScore(tokens, tokenizePatentWatchText([d.inventionTitle, d.abstractText ?? "", d.claimsText].join("\n")));
          if (lexicalScore <= 0) continue;
          candidates.push({ candidateId: d.documentId, sourceKey, publicationDate: d.publicationDate,
            inventionTitle: d.inventionTitle.slice(0, 1000), applicationNumber: d.applicationNumber, abstract: d.abstractText?.slice(0, 500) ?? null,
            source, claimsStatus: source ? "complete" : m ? "review_required" : "missing", lexicalScore });
          candidates.sort((a,b) => b.lexicalScore - a.lexicalScore || b.publicationDate.localeCompare(a.publicationDate) || a.candidateId - b.candidateId);
          if (candidates.length > 100) candidates.pop();
          requireState(candidates.reduce((n,c)=>n+(c.source?.claims.reduce((bytes,claim)=>bytes+Buffer.byteLength(claim.text),0)??0),0)<=48*1024**2,"limit");
        }
      }
      const snapshot: ManagedRunSnapshot = { schema: 1, setting, period, sourceKeys: [...sourceKeys], candidates,
        scannedDocuments: sourceKeys.size, incompleteDocuments, sourceBytes };
      validateManagedSnapshot(snapshot);
      const snapshotJson = JSON.stringify(snapshot); requireState(Buffer.byteLength(snapshotJson) <= 64 * 1024 ** 2, "limit");
      const [saved] = await tx.insert(R).values({ runId: randomUUID(), settingId: setting.settingId, caseId, status: "prepared",
        periodFrom: period.from, periodTo: period.to, baseDigest: setting.baseDigest, snapshotJson, snapshotDigest: managedDigest(snapshot),sourceDocumentId:setting.source.documentId,
        countsJson: JSON.stringify({ populationDocuments, scannedDocuments: sourceKeys.size, incompleteDocuments, prefiltered: candidates.length, sourceBytes }) }).returning();
      return runFrom(saved);
    }, { isolationLevel: "repeatable read" });
  }
  /** Called only by the fixed Job after it starts; a second worker may not take over. */
  async claim(caseId: number, runId: string, executionId: string, proof?: { operationId: string; snapshotDigest: string }): Promise<ManagedRun> {
    requireState(/^[a-zA-Z0-9_.-]{1,180}$/.test(executionId), "invalid_setting");
    return this.database.transaction(async tx => {
      const [row] = await tx.select().from(R).where(and(eq(R.caseId, caseId), eq(R.runId, runId))).for("update"); requireState(row, "not_found");
      requireState(row.status === "prepared" && row.executionId === null && row.consumedNormal === 0, "in_progress");
      if (row.startReservationId !== null || proof) {
        requireState(proof && row.startReservationId === proof.operationId && row.snapshotDigest === proof.snapshotDigest);
        const J = schema.managedWatchJobStarts;
        const [start] = await tx.select().from(J).where(eq(J.operationId,proof.operationId)).for("update");
        requireState(start && ["submitting","accepted","unknown"].includes(start.status) && (start.executionId === null || start.executionId === executionId));
        const config = managedCloudConfigSchema.parse(JSON.parse(start.configJson));
        requireState(managedDigest(config) === start.configDigest && Date.parse(config.expiresAt) > Date.now() &&
          config.runs.some(r=>r.caseId===caseId&&r.runId===runId&&r.snapshotDigest===row.snapshotDigest));
        await tx.update(J).set({ status:"accepted",executionId }).where(eq(J.operationId,start.operationId));
      }
      const now = Date.now();
      const [saved] = await tx.update(R).set({ status: "running", executionId, acceptedAt: new Date(now).toISOString(), deadlineAt: new Date(now + RUN_MS).toISOString() }).where(eq(R.runId, runId)).returning();
      return runFrom(saved);
    });
  }
  private async running(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], run: ManagedRun) {
    const [row] = await tx.select().from(R).where(and(eq(R.caseId, run.caseId), eq(R.runId, run.runId))).for("update");
    requireState(row && row.status === "running" && row.settingId === run.settingId && row.executionId === run.executionId && row.snapshotDigest === run.snapshotDigest &&
      managedDigest(run.snapshot) === row.snapshotDigest &&
      row.deadlineAt !== null && Date.parse(row.deadlineAt) > Date.now(), "expired");
    return row;
  }
  journal(run: ManagedRun, stage: "screening" | "detail", chunkIndex: number | null, inputDigest: string, aiBudget: ManagedWatchAiBudget): ManagedWatchDispatchJournal {
    const fixedBudget = Object.freeze(managedWatchAiBudgetSchema.parse(aiBudget));
    return {
      reserve: async entry => this.database.transaction(async tx => {
        const row = await this.running(tx, run);
        const current = runFrom(row);
        requireState(entry.ordinal === row.consumedNormal + 1 && entry.ordinal <= 41, "limit");
        requireState(stage === "screening" ? entry.ordinal === 1 && chunkIndex === null && row.planJson === null
          : row.planJson !== null && chunkIndex !== null && entry.ordinal === chunkIndex + 2);
        requireState(stage === "screening" ? inputDigest === managedDigest(managedScreeningInput(current.snapshot))
          : current.plan?.chunks[chunkIndex!] && inputDigest === managedDigest(current.plan.chunks[chunkIndex!]), "incomplete");
        const previous = await tx.select({ estimatedInputTokens: D.estimatedInputTokens, maximumOutputTokens: D.maximumOutputTokens })
          .from(D).where(eq(D.runId, run.runId));
        requireState(previous.length === row.consumedNormal, "incomplete");
        requireManagedWatchCost(fixedBudget, [...previous, entry]);
        await tx.insert(D).values({ runId: run.runId, ...entry, stage, chunkIndex, inputDigest, status: "reserved" });
        await tx.update(R).set({ consumedNormal: entry.ordinal }).where(eq(R.runId, run.runId));
      }),
      reconcile: async entry => this.database.transaction(async tx => {
        await this.running(tx, run);
        const saved = await tx.update(D).set({ inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, status: "reconciled" })
          .where(and(eq(D.runId, run.runId), eq(D.ordinal, entry.ordinal), eq(D.status, "reserved"), eq(D.inputDigest, inputDigest))).returning({ id: D.dispatchId });
        requireState(saved.length === 1);
      }),
    };
  }
  async saveScreening(run: ManagedRun, selectedIds: number[]) {
    requireState(selectedIds.length <= 20 && new Set(selectedIds).size === selectedIds.length, "incomplete");
    return this.database.transaction(async tx => {
      const current = runFrom(await this.running(tx, run));
      const selected = current.snapshot.candidates.filter(c => selectedIds.includes(c.candidateId));
      requireState(selected.length === selectedIds.length && selected.every(c => c.source), "incomplete");
      const plan = planManagedComparisons(current.snapshot.setting.base, current.snapshot.setting.selectedClaimNos,
        selected.map(c => ({ candidateId: c.candidateId, source: c.source! })));
      const saved = await tx.update(D).set({ resultJson: JSON.stringify({ selectedIds }), status: "completed" })
        .where(and(eq(D.runId, run.runId), eq(D.ordinal, 1), eq(D.status, "reconciled"), eq(D.stage, "screening"))).returning({ id: D.dispatchId });
      requireState(saved.length === 1);
      await tx.update(R).set({ planJson: JSON.stringify(plan), planDigest: plan.digest }).where(eq(R.runId, run.runId));
      return plan;
    });
  }
  async saveDetail(run: ManagedRun, index: number, value: unknown) {
    requireState(run.plan?.chunks[index], "incomplete"); const results = validateManagedComparisons(run.plan.chunks[index], value);
    await this.database.transaction(async tx => {
      const row = await this.running(tx, run); requireState(row.planDigest === run.plan!.digest);
      const saved = await tx.update(D).set({ resultJson: JSON.stringify({ results }), status: "completed" })
        .where(and(eq(D.runId, run.runId), eq(D.ordinal, index + 2), eq(D.status, "reconciled"), eq(D.stage, "detail"), eq(D.chunkIndex, index))).returning({ id: D.dispatchId });
      requireState(saved.length === 1);
    });
  }
  async fail(run: ManagedRun, unknown: boolean) {
    await this.database.update(R).set({ status: unknown ? "unknown" : "failed", errorCode: unknown ? "outcome_unknown" : "incomplete", completedAt: new Date().toISOString() })
      .where(and(eq(R.caseId, run.caseId), eq(R.runId, run.runId), eq(R.executionId, run.executionId!), eq(R.status, "running")));
  }
  /** Read-after-restart never sends AI. Only wholly persisted results can finalize. */
  async finalize(run: ManagedRun) {
    return this.database.transaction(async tx => {
      const row = await this.running(tx, run), current = runFrom(row);
      const dispatches = await tx.select().from(D).where(eq(D.runId, run.runId)).orderBy(asc(D.ordinal));
      const empty = current.snapshot.candidates.length === 0;
      requireState(empty ? dispatches.length === 0 && row.consumedNormal === 0 : current.plan &&
        dispatches.length === current.plan.chunks.length + 1 && row.consumedNormal === dispatches.length && dispatches.every(d => d.status === "completed"), "incomplete");
      const grouped = new Map<number, ReturnType<typeof validateManagedComparisons>>();
      if (!empty) {
        const selectedIds = JSON.parse(dispatches[0].resultJson!).selectedIds as number[];
        requireState(Array.isArray(selectedIds) && new Set(selectedIds).size === selectedIds.length && selectedIds.length <= 20, "incomplete");
        const actual = new Set(current.plan!.chunks.map(c => c.candidateId));
        requireState(actual.size === selectedIds.length && selectedIds.every(id => actual.has(id)), "incomplete");
        current.plan!.chunks.forEach((chunk, i) => {
          const dispatch = dispatches[i + 1];
          requireState(dispatch.ordinal === i + 2 && dispatch.chunkIndex === i && dispatch.inputDigest === managedDigest(chunk), "incomplete");
          grouped.set(chunk.candidateId, [...(grouped.get(chunk.candidateId) ?? []), ...validateManagedComparisons(chunk, JSON.parse(dispatch.resultJson!))]);
        });
      }
      for (const [candidateId, results] of grouped) {
        const candidate = current.snapshot.candidates.find(c => c.candidateId === candidateId)!;
        const period = managedPeriodForPublication(current.snapshot.setting.monitoringStartsOn, candidate.publicationDate); requireState(period, "incomplete");
        await tx.insert(F).values({ settingId: current.settingId, runId: current.runId, baseDigest: current.snapshot.setting.baseDigest, sourceKey: candidate.sourceKey,
          publicationNumber: candidate.source!.publicationNumber, publicationDate: candidate.publicationDate, periodFrom: period.from, periodTo: period.to,
          relation: candidate.source!.publicationNumber === current.snapshot.setting.base.publicationNumber || candidate.applicationNumber===current.snapshot.setting.source.applicationNumber ? "own_publication" : "unknown",
          analysisJson: JSON.stringify({ candidateId, results }) });
      }
      const counts = { ...JSON.parse(row.countsJson!), screened: empty ? 0 : current.snapshot.candidates.length,
        compared: grouped.size, detailCalls: current.plan?.chunks.length ?? 0, normalCalls: row.consumedNormal,
        inputTokens: dispatches.reduce((n,d) => n + (d.inputTokens ?? 0), 0), outputTokens: dispatches.reduce((n,d) => n + (d.outputTokens ?? 0), 0) };
      await tx.update(R).set({ status: "completed", completedAt: new Date().toISOString(), countsJson: JSON.stringify(counts) }).where(eq(R.runId, run.runId));
      return counts;
    });
  }
  async findingReview(caseId:number,findingId:number){
    const [row]=await this.database.select({findingId:F.findingId,reviewStatus:F.reviewStatus,reviewVersion:F.reviewVersion}).from(F)
      .innerJoin(S,eq(S.settingId,F.settingId)).where(and(eq(S.caseId,caseId),eq(F.findingId,findingId)));
    requireState(row,"not_found");return row;
  }
  async reviewFinding(caseId: number, findingId: number, reviewed: boolean, expectedVersion:number) {
    const setting = await this.setting(caseId); requireState(setting, "not_found");
    await this.findingReview(caseId,findingId);
    requireState(Number.isSafeInteger(expectedVersion)&&expectedVersion>=0&&expectedVersion<2147483647,"invalid_setting");
    const saved = await this.database.update(F).set({ reviewStatus: reviewed ? "reviewed" : "unreviewed",reviewVersion:sql`${F.reviewVersion}+1` })
      .where(and(eq(F.settingId, setting.settingId), eq(F.findingId, findingId),eq(F.reviewVersion,expectedVersion))).returning({ id: F.findingId });
    requireState(saved.length === 1, "conflict");
  }
  async hasUnknownDispatch(run: ManagedRun) {
    const rows = await this.database.select({ id: D.dispatchId }).from(D).where(and(eq(D.runId, run.runId), eq(D.status, "reserved"))).limit(1);
    return rows.length > 0;
  }
}
