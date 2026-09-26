import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { ManagedWatchRepository, readManagedStoredRun } from "./managed-watch";
import { managedExplanations, projectManagedDeliveryDisplay, validateManagedDelivery, type ManagedDelivery } from "../lib/patent-watch/managed-delivery";
import { acquireManagedDistribution, managedDistributionRows, validateManagedCoverage } from "../lib/patent-watch/managed-distribution";
import { managedPackageReceiptSchema } from "../lib/koho-import/managed-package-receipt";
import { managedDigest, validateManagedComparisons, type ManagedComparison } from "../lib/patent-watch/managed-claims";
import { managedDeliveryDueOn, managedPeriodForPublication, JAPAN_HOLIDAYS, validateManagedPeriod, type PublicationPeriod } from "../lib/patent-watch/managed-period";
import { ManagedWatchError } from "../lib/patent-watch/managed-types";
import type { ManagedArtifactManifest } from "../lib/patent-watch/managed-storage";
type Database = NodePgDatabase<typeof schema>;
const T = schema.managedWatchDeliveries, R = schema.managedWatchRuns, F = schema.managedWatchFindings;
const requireState = (ok: unknown) => { if (!ok) throw new ManagedWatchError("incomplete"); };
export class ManagedDeliveryRepository {
  constructor(private readonly database: Database) {}
  async acquireDistribution() {
    const snapshot = await acquireManagedDistribution(), T = schema.managedDistributionSnapshots;
    await this.database.insert(T).values(snapshot).onConflictDoNothing({ target: T.sha256 });
    const [stored] = await this.database.select().from(T).where(eq(T.sha256, snapshot.sha256));
    requireState(stored && stored.csvText === snapshot.csvText && stored.sourceUrl === snapshot.sourceUrl);
    return { sha256: stored.sha256, acquiredAt: stored.acquiredAt };
  }
  async prepare(caseId: number, period: PublicationPeriod, coverageInput: unknown, reason: ManagedDelivery["reason"], deliveredOn: string | null = null, deliveryId:string = randomUUID(), deadline?:AbortSignal) {
    validateManagedPeriod(period);
    const coverage = validateManagedCoverage(coverageInput);
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(129129::bigint)`);
      deadline?.throwIfAborted();
      const [already] = await tx.select({id:T.deliveryId}).from(T).where(eq(T.deliveryId,deliveryId));
      if(already)throw new ManagedWatchError("conflict");
      const setting = await new ManagedWatchRepository(tx as unknown as Database).setting(caseId);
      if (!setting) throw new ManagedWatchError("not_found");
      const expectedPeriod = managedPeriodForPublication(setting.monitoringStartsOn, period.to);
      requireState(expectedPeriod?.from === period.from && expectedPeriod.to === period.to);
      const [distribution] = await tx.select().from(schema.managedDistributionSnapshots).where(eq(schema.managedDistributionSnapshots.sha256, coverage.distributionTableSha256));
      requireState(distribution);
      const packages = managedDistributionRows(distribution, period);
      requireState(packages.length <= 64);
      const [previous] = await tx.select().from(T).where(and(eq(T.settingId, setting.settingId), eq(T.periodFrom, period.from), eq(T.periodTo, period.to))).orderBy(desc(T.version)).limit(1);
      requireState(!previous || ["stored", "abandoned"].includes(previous.status));
      requireState(previous ? reason !== "initial" : reason === "initial");
      const runSize = await tx.select({ bytes: sql<string>`coalesce(sum(octet_length(${R.snapshotJson}) + coalesce(octet_length(${R.planJson}),0)),0)` })
        .from(R).where(and(eq(R.settingId, setting.settingId), eq(R.baseDigest, setting.baseDigest)));
      requireState(Number(runSize[0].bytes) <= 64 * 1024**2);
      const rows = await tx.select().from(R).where(and(eq(R.settingId, setting.settingId), eq(R.baseDigest, setting.baseDigest))).orderBy(asc(R.createdAt)).limit(1001);
      requireState(rows.length <= 1000);
      const runs = rows.map(readManagedStoredRun);
      requireState(runs.every(run => run.caseId === caseId && run.settingId === setting.settingId && run.snapshot.setting.baseDigest === setting.baseDigest));
      const sourceKeys = new Set(runs.filter(r=>r.status==="completed").flatMap(r=>r.snapshot.sourceKeys));
      const corpus = schema.kohoImportDocuments, imports = schema.kohoImportRuns, metadata = schema.managedPublicationClaims;
      const receipts = schema.managedImportReceipts;
      const available = await tx.select({ run: imports, receipt: receipts }).from(imports).innerJoin(receipts, eq(receipts.importId, imports.importId))
        .where(inArray(receipts.issueNumber, packages.map(p => p.issueNumber)));
      const availableIds: number[] = [];
      const expectedCounts = new Map<number, { A1: number; P1: number; total: number }>();
      for (const pkg of packages) {
        const matches = available.filter(row=>row.receipt.issueNumber===pkg.issueNumber && row.run.packageType==="JPA");
        requireState(matches.length <= 1);
        if (matches.length) {
          const { run, receipt: stored } = matches[0], receipt = managedPackageReceiptSchema.parse(JSON.parse(stored.receiptJson));
          requireState(managedDigest(receipt) === stored.receiptDigest && receipt.sourceSha256 === run.sourceSha256 && stored.sourceSha256 === run.sourceSha256 &&
            stored.publicationDate === receipt.publicationDate && receipt.publicationDate === pkg.publicationDate && receipt.issueNumber === pkg.issueNumber &&
            receipt.cumulativeIssue === pkg.cumulativeIssue && run.packageStatus !== "failed" && run.documentCount === receipt.documentCount &&
            receipt.publishedCount + receipt.publishedAmendments === pkg.publishedCount && receipt.translatedCount + receipt.translatedAmendments === pkg.translatedCount && run.amendmentCount === receipt.amendmentCount);
          if (pkg.available) {
            availableIds.push(run.importId);
            expectedCounts.set(run.importId, { A1: receipt.publishedCount, P1: receipt.translatedCount, total: receipt.documentCount });
          }
        }
      }
      const periodSources = new Set<string>();
      // Later packages can amend an earlier public period. Never discard them by issue date.
      const receiptSize = await tx.select({ bytes: sql<string>`coalesce(sum(octet_length(${receipts.receiptJson})),0)` }).from(receipts);
      requireState(Number(receiptSize[0].bytes) <= 32*1024**2);
      const allReceipts = await tx.select().from(receipts).orderBy(asc(receipts.importId)).limit(1001);
      requireState(allReceipts.length <= 1000);
      const correctionEvents = new Map<string, ReturnType<typeof managedPackageReceiptSchema.parse>["corrections"][number]>();
      for (const stored of allReceipts) {
        const receipt = managedPackageReceiptSchema.parse(JSON.parse(stored.receiptJson));
        requireState(managedDigest(receipt) === stored.receiptDigest && receipt.sourceSha256 === stored.sourceSha256);
        for (const event of receipt.corrections) correctionEvents.set(event.eventKey, event);
      }
      let unresolvedCorrections = 0;
      const unknownEvents = [...correctionEvents.values()].filter(e => e.claimsEffect !== "none" && !e.originalPublicationDate);
      const linked = unknownEvents.length ? await tx.select({ applicationNumber: corpus.applicationNumber, publicationNumber: corpus.publicationNumber, publicationDate: corpus.publicationDate })
        .from(corpus).where(inArray(corpus.applicationNumber, [...new Set(unknownEvents.map(e=>e.applicationNumber))])).limit(20_001) : [];
      requireState(linked.length <= 20_000);
      for (const event of correctionEvents.values()) {
        if (event.claimsEffect === "none") continue;
        let originalDate = event.originalPublicationDate;
        if (!originalDate) {
          const matches = linked.filter(d=>d.applicationNumber===event.applicationNumber && (!event.originalPublicationNumber || d.publicationNumber===event.originalPublicationNumber));
          const identities = new Set(matches.map(d=>`${d.publicationNumber}:${d.publicationDate}`));
          if (identities.size === 1) originalDate = matches[0].publicationDate;
        }
        if (!originalDate || (originalDate >= period.from && originalDate <= period.to)) unresolvedCorrections++;
      }
      let importedDocuments = 0, incompleteDocuments = 0, processedDocuments = 0, after = 0;
      const actualCounts = new Map(availableIds.map(id => [id, { A1: 0, P1: 0, total: 0 }]));
      if (availableIds.length) for (;;) {
        deadline?.throwIfAborted();
        const documents = await tx.select({ document:{documentId:corpus.documentId,importId:corpus.importId,publicationDate:corpus.publicationDate,kind:corpus.kind,
          publicationNumber:corpus.publicationNumber,contentSha256:corpus.contentSha256},claim:{status:metadata.status,claimsDigest:metadata.claimsDigest} }).from(corpus).leftJoin(metadata,eq(metadata.documentId,corpus.documentId))
          .where(and(inArray(corpus.importId,availableIds),sql`${corpus.documentId}>${after}`)).orderBy(asc(corpus.documentId)).limit(500);
        if (!documents.length) break;
        for (const { document:d, claim:m } of documents) {
          after=d.documentId; requireState(++importedDocuments <= 100_000);
          requireState(d.publicationDate>=period.from && d.publicationDate<=period.to && ["A1","P1"].includes(d.kind));
          const actual = actualCounts.get(d.importId); requireState(actual);
          actual!.total++; actual![d.kind as "A1" | "P1"]++;
          if (!m || m.status!=="complete") incompleteDocuments++;
          const key=managedDigest({publicationNumber:d.publicationNumber,content:d.contentSha256,numberedClaims:m?.claimsDigest??null,completeness:m?.status??"missing"});
          periodSources.add(key);
          if (sourceKeys.has(key)) processedDocuments++;
        }
      }
      requireState([...expectedCounts].every(([id, expected]) => {
        const actual = actualCounts.get(id)!;
        return actual.A1 === expected.A1 && actual.P1 === expected.P1 && actual.total === expected.total;
      }));
      const storedFindings = await tx.select().from(F).where(and(eq(F.settingId,setting.settingId),eq(F.baseDigest,setting.baseDigest),eq(F.periodFrom,period.from),eq(F.periodTo,period.to)))
        .orderBy(asc(F.publicationDate),asc(F.findingId)).limit(20_001);
      requireState(storedFindings.length<=20_000);
      const allFullClaims = new Set<string>();
      const findings: ManagedDelivery["findings"] = storedFindings.map(f=>{
        requireState(periodSources.has(f.sourceKey));
        const run=runs.find(r=>r.runId===f.runId); requireState(run?.status==="completed" && run.plan && run.caseId===caseId);
        const parsed=JSON.parse(f.analysisJson) as {candidateId:number;results:ManagedComparison[]};
        requireState(Object.keys(parsed).every(k=>["candidateId","results"].includes(k)) && Array.isArray(parsed.results));
        const candidate=run!.snapshot.candidates.find(c=>c.candidateId===parsed.candidateId);
        requireState(candidate?.source && candidate.sourceKey===f.sourceKey && candidate.source.publicationNumber===f.publicationNumber && candidate.publicationDate===f.publicationDate);
        const chunks=run!.plan!.chunks.filter(c=>c.candidateId===parsed.candidateId);
        requireState(chunks.length && chunks.reduce((n,c)=>n+c.pairs.length,0)===parsed.results.length);
        const results=chunks.flatMap(chunk=>validateManagedComparisons(chunk,{results:parsed.results.filter(r=>chunk.pairs.some(p=>p.baseClaimNo===r.baseClaimNo&&p.candidateClaimNo===r.candidateClaimNo))}));
        const fullClaims=[...run!.snapshot.setting.base.claims,...candidate!.source!.claims].map(c=>c.text);
        fullClaims.forEach(text=>allFullClaims.add(text));
        const explanations=managedExplanations(results.map(c=>c.explanation),fullClaims);
        const comparisons=results.map((c,index)=>({ baseClaimNo:c.baseClaimNo,candidateClaimNo:c.candidateClaimNo,
          baseEvidence:{claimNo:c.baseEvidence.claimNo,start:c.baseEvidence.start,end:c.baseEvidence.end},
          candidateEvidence:{claimNo:c.candidateEvidence.claimNo,start:c.candidateEvidence.start,end:c.candidateEvidence.end},
          lexicalScore:c.lexicalScore,elementScore:c.elementScore,semanticScore:c.semanticScore,structuralScore:c.structuralScore,riskLabel:c.riskLabel,
          explanation:explanations[index]}));
        requireState(["reviewed","unreviewed"].includes(f.reviewStatus) && ["own_publication","other_applicant","unknown"].includes(f.relation));
        return {findingId:f.findingId,publicationNumber:f.publicationNumber,publicationDate:f.publicationDate,inventionTitle:candidate!.inventionTitle,
          detectedAt:new Date(f.detectedAt).toISOString(),reviewStatus:f.reviewStatus as "reviewed"|"unreviewed",relation:f.relation as ManagedDelivery["findings"][number]["relation"],comparisons};
      });
      const safeExplanations = managedExplanations(findings.flatMap(f=>f.comparisons.map(c=>c.explanation)), [...allFullClaims]);
      let explanationIndex = 0;
      for (const finding of findings) for (const comparison of finding.comparisons) comparison.explanation = safeExplanations[explanationIndex++];
      const relevant=runs.filter(r=>r.snapshot.period.from===period.from || r.snapshot.sourceKeys.some(key=>periodSources.has(key)));
      const completed=relevant.filter(r=>r.status==="completed");
      const lastCompleted=rows.filter(r=>completed.some(c=>c.runId===r.runId)).at(-1);
      const failed=relevant.filter(r=>r.status==="failed" && (!lastCompleted || Date.parse(r.acceptedAt!)>Date.parse(lastCompleted.acceptedAt!) || r.snapshot.sourceKeys.some(k=>periodSources.has(k)&&!sourceKeys.has(k))));
      const active=relevant.filter(r=>["prepared","running","unknown"].includes(r.status));
      deadline?.throwIfAborted();
      const report=projectManagedDeliveryDisplay(validateManagedDelivery({schema:1,deliveryId,caseId,version:(previous?.version??0)+1,previousDeliveryId:previous?.deliveryId??null,reason,
        period,generatedAt:new Date().toISOString(),deliveryDueOn:managedDeliveryDueOn(period,JAPAN_HOLIDAYS),deliveredOn,
        contractSignedOn:setting.contractSignedOn,monitoringStartsOn:setting.monitoringStartsOn,contractEndsOn:setting.contractEndsOn,
        base:{publicationNumber:setting.base.publicationNumber,version:setting.base.version,selectedClaimNos:setting.selectedClaimNos},
        coverage:{expectedPackages:packages.length,availablePackages:availableIds.length,importedDocuments,incompleteDocuments,
          observedCorrections:correctionEvents.size,unresolvedCorrections,
          prefiltered:completed.reduce((n,r)=>n+r.snapshot.candidates.filter(c=>c.publicationDate>=period.from&&c.publicationDate<=period.to).length,0),compared:findings.length,completedRuns:completed.length,failedRuns:failed.length,activeRuns:active.length,
          acquiredAt:new Date(distribution.acquiredAt).toISOString(),comparedAt:lastCompleted?.completedAt?new Date(lastCompleted.completedAt).toISOString():null,
          complete:availableIds.length===packages.length && processedDocuments===importedDocuments && completed.length>0 && !incompleteDocuments && !unresolvedCorrections && !failed.length && !active.length},findings}));
      const snapshotJson=JSON.stringify(report);requireState(Buffer.byteLength(snapshotJson)<=16*1024**2);
      await tx.insert(T).values({deliveryId:report.deliveryId,settingId:setting.settingId,caseId,periodFrom:period.from,periodTo:period.to,
        version:report.version,previousDeliveryId:report.previousDeliveryId,reason,status:"prepared",baseDigest:setting.baseDigest,
        distributionSha256:distribution.sha256,snapshotJson,snapshotDigest:managedDigest(report),deliveredOn});
      return report;
    },{isolationLevel:"repeatable read"});
  }
  async get(caseId:number,deliveryId:string) {
    const [row]=await this.database.select().from(T).where(and(eq(T.caseId,caseId),eq(T.deliveryId,deliveryId)));
    if(!row)throw new ManagedWatchError("not_found");
    const report=validateManagedDelivery(JSON.parse(row.snapshotJson));
    requireState(report.caseId===caseId&&report.deliveryId===deliveryId&&managedDigest(report)===row.snapshotDigest&&report.version===row.version);
    return {report,status:row.status,manifest:row.blobManifestJson?JSON.parse(row.blobManifestJson) as ManagedArtifactManifest:null};
  }
  async abandonPreparation(caseId:number,deliveryId:string){
    const saved=await this.database.update(T).set({status:"abandoned"}).where(and(eq(T.caseId,caseId),eq(T.deliveryId,deliveryId),eq(T.status,"prepared"),
      sql`${T.blobManifestJson} is null`,sql`${T.createdAt} < now() - interval '10 minutes'`)).returning({id:T.deliveryId});
    if(saved.length!==1)throw new ManagedWatchError("conflict");
  }
  async list(caseId:number){
    return this.database.select({deliveryId:T.deliveryId,version:T.version,periodFrom:T.periodFrom,periodTo:T.periodTo,status:T.status,createdAt:T.createdAt})
      .from(T).where(eq(T.caseId,caseId)).orderBy(desc(T.createdAt)).limit(1000);
  }
  async reserveArtifacts(report:ManagedDelivery,manifest:ManagedArtifactManifest){
    const saved=await this.database.update(T).set({blobManifestJson:JSON.stringify(manifest)})
      .where(and(eq(T.caseId,report.caseId),eq(T.deliveryId,report.deliveryId),eq(T.snapshotDigest,managedDigest(report)),eq(T.status,"prepared"),sql`${T.blobManifestJson} is null`,sql`${T.createdAt} > now() - interval '60 seconds'`))
      .returning({id:T.deliveryId});requireState(saved.length===1);
  }
  async markArtifacts(report:ManagedDelivery,manifest:ManagedArtifactManifest,status:"stored"|"storage_unknown"|"abandoned"){
    const saved=await this.database.update(T).set({status})
      .where(and(eq(T.caseId,report.caseId),eq(T.deliveryId,report.deliveryId),eq(T.snapshotDigest,managedDigest(report)),eq(T.blobManifestJson,JSON.stringify(manifest)),inArray(T.status,["prepared","storage_unknown",status]),
        status==="abandoned"?sql`${T.createdAt} < now() - interval '10 minutes'`:undefined))
      .returning({id:T.deliveryId});requireState(saved.length===1);
  }
}
