import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { AnonymousCredential, BlobServiceClient, newPipeline } from "@azure/storage-blob";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { parse } from "csv-parse/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { manualFixture } from "./koho-manual-import-fixtures";
import { openKohoZip } from "../src/lib/koho-zip";
import { buildKohoManualImportLimits } from "../src/lib/koho-import/manual-api";
import { prepareTrialFictionalManifest } from "../src/lib/trial/fictional-preparation";
import { TRIAL_FICTIONAL_SOURCE, trialFictionalDigest } from "../src/lib/trial/fictional-manifest";
import { assertTrialFictionalRun } from "../src/lib/trial/fictional-run";
import { trialFixture, signedTrialEnvironment, trialHeaders } from "../src/lib/trial/policy.test-support";
import { withOwnerRoute } from "../src/lib/owner-http";
import { TrialLedger, trialHash } from "../src/lib/trial/ledger";
import { ledgerFixture } from "../src/lib/trial/ledger.test-support";
import { saveKohoImportPlan } from "../src/repositories/drizzle";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { ManagedDeliveryRepository } from "../src/repositories/managed-delivery";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";
import { managedScreeningInput } from "../src/lib/patent-watch/managed-types";
import { FICTIONAL_TRIAL_NOTICE, FICTIONAL_TRIAL_SOURCE_NOTICE } from "../src/lib/patent-watch/managed-delivery";
import { ManagedPrivateStorage, createManagedDelivery, reconcileManagedDelivery } from "../src/lib/patent-watch/managed-storage";
import * as schema from "../src/db/schema";

vi.mock("../src/lib/trial/runtime", () => ({ verifyTrialBuild: vi.fn(async () => undefined) }));

/** Real Blob SDK with only its final HTTP transport replaced. Every request
 * remains local; unexpected methods/targets are rejected, not forwarded. */
function memoryArtifacts(account: string, container: string) {
  const files = new Map<string, Buffer>(), requests: string[] = [];
  const pipeline = newPipeline(new AnonymousCredential(), { retryOptions: { maxTries: 1 }, httpClient: {
    async sendRequest(request) {
      const url = new URL(request.url), path = url.pathname;
      if (url.origin !== `https://${account}.blob.core.windows.net` || !path.startsWith(`/${container}`) ||
          !["GET", "HEAD", "PUT"].includes(request.method)) throw Error("fixture_transport_denied");
      requests.push(request.method);
      const headers = request.headers.clone(); for (const name of headers.headerNames()) headers.remove(name);
      headers.set("x-ms-request-id", "fictional"); headers.set("x-ms-version", "2025-11-05");
      let status = 200; let body: Buffer = Buffer.alloc(0);
      if (url.searchParams.get("restype") === "container") { if (path !== `/${container}`) throw Error("fixture_container"); }
      else if (request.method === "PUT") {
        if (request.headers.get("if-none-match") !== "*" || files.has(path)) throw Error("fixture_immutable");
        files.set(path, Buffer.from(request.body as Uint8Array)); status = 201;
      } else {
        if (!files.has(path)) throw Error("fixture_missing");
        body = files.get(path)!; headers.set("etag", '"fixture"'); headers.set("content-length", String(body.length));
      }
      return { request, status, headers, readableStreamBody: Readable.from(body) };
    },
  } });
  return { requests, storage: new ManagedPrivateStorage(new BlobServiceClient(`https://${account}.blob.core.windows.net`, pipeline).getContainerClient(container)) };
}

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1")("signed fictional collection compatibility on isolated PG16", () => {
  let env: Awaited<ReturnType<typeof isolatedPg16>> | undefined, importer: Client | undefined;
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await importer?.end(); await env?.cleanup(); }, 60_000);
  it("imports unchanged originals, saves nonempty findings and real artifacts, and preserves an older revision", async () => {
    env = await isolatedPg16(129);
    const outsideNetwork = vi.fn(async () => { throw Error("external_network_forbidden"); }); vi.stubGlobal("fetch", outsideNetwork);
    const period = { from: "2026-09-01", to: "2026-09-25" };
    const directory = process.env.LOCAL_FICTIONAL_INPUTS;
    const zip = directory ? await readFile(join(directory, "JPA.zip")) : manualFixture("JPA", 4, {
      publicationDate: "2026-09-01", issue: "2026-148", control: "01115", claims: [{ number: "1", text: "完全架空の検出装置と制御部。" }] });
    if (directory && trialHash(zip) !== process.env.LOCAL_FICTIONAL_ZIP_SHA256) throw Error("fixture_zip_pin_mismatch");
    const reader = await openKohoZip({ source: { type: "buffer", bytes: zip }, limits: buildKohoManualImportLimits(zip.length).zip });
    const entries: { entryPath: string; bytes: Buffer }[] = [];
    try { for (const entry of reader.entries.filter(e => e.pathCandidate === "primary_xml"))
      entries.push({ entryPath: entry.normalizedPath, bytes: Buffer.from(await reader.readEntryBytes(entry.id)) });
    } finally { await reader.close(); }
    expect(entries.length).toBe(4);
    const originals: { caseId: number; bytes: Buffer; entryPath: string; sha256: string }[] = [];
    const pinnedOriginals = directory ? JSON.parse(process.env.LOCAL_FICTIONAL_XML_SHA256 ?? "[]") as string[] : null;
    if (pinnedOriginals && pinnedOriginals.length !== 4) throw Error("fixture_original_pins_missing");
    for (let index = 0; index < 4; index++) {
      const bytes = directory ? await readFile(join(directory, `sample-${index + 1}.xml`)) : entries[index].bytes;
      if (pinnedOriginals && trialHash(bytes) !== pinnedOriginals[index]) throw Error("fixture_original_pin_mismatch");
      const matched = entries.filter(entry => entry.bytes.equals(bytes)); expect(matched.length).toBe(1);
      originals.push({ caseId: index + 1, bytes, entryPath: matched[0].entryPath, sha256: trialHash(bytes) });
    }
    const input = { zip, packageSha256: trialHash(zip), period, originals };
    await expect(prepareTrialFictionalManifest({ ...input, period: { ...period, to: "2026-09-30" } })).rejects.toThrow();
    await expect(prepareTrialFictionalManifest({ ...input, originals: originals.map((o, i) => i ? o : { ...o, bytes: originals[1].bytes, sha256: originals[1].sha256 }) })).rejects.toThrow();
    const prepared = await prepareTrialFictionalManifest(input); expect(prepared.manifest.records.length).toBe(4);
    // Only JS Date is fixed. Real timers and PG created_at/now() remain real,
    // including the database's fresh-artifact reservation check.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-17T00:01:00Z");
    const now = Date.now(), iso = (n: number) => new Date(n).toISOString();
    const p = { ...structuredClone(trialFixture), phase: "initial" as const, startsAt: iso(now - 60_000), endsAt: iso(now + 20 * 60_000),
      samples: prepared.samples.map(s => ({ caseId: s.caseId, from: period.from, through: period.to })), fictionalDistribution: prepared.manifest,
      cost: { checkedAt: iso(now - 60_000), validUntil: iso(now + 60 * 60_000), normal: { inputYenPerMillion: 500, outputYenPerMillion: 3000 },
        mini: { inputYenPerMillion: 150, outputYenPerMillion: 900 }, jobYenPerHour: 100, initialOtherYen: 0, retainedOtherYen: 0, monthOtherYen: 0, sharedRemainingYen: 15000, databaseBaselineBytes: 0 } };
    const signed = signedTrialEnvironment(p); delete (signed as Partial<typeof signed>).DATABASE_URL;
    for (const [key, value] of Object.entries(signed)) vi.stubEnv(key, value);
    const memory = ledgerFixture(p), ledger = new TrialLedger(p, memory.io, () => Date.now());
    vi.spyOn(TrialLedger, "configured").mockReturnValue(ledger);
    importer = new Client({ ...env.connection, ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 20000, query_timeout: 22000 }); await importer.connect();
    const watcher = (await env.watchClient.query("select current_user as name")).rows[0].name as string;
    if (!/^watch_test_[a-f0-9]{16}$/.test(watcher) || !/^manual_import_[a-f0-9]{16}$/.test(env.connection.user)) throw Error("fixture_role");
    await env.sql(`GRANT SELECT, UPDATE ON prior_art_documents TO ${watcher}`);
    await env.sql(`GRANT SELECT, INSERT, UPDATE ON managed_watch_settings, managed_watch_runs, managed_watch_dispatches, managed_watch_findings, managed_watch_deliveries, managed_watch_job_starts TO ${watcher}`);
    await env.sql(`GRANT SELECT, INSERT ON managed_distribution_snapshots TO ${watcher}`);
    await env.sql(`GRANT SELECT ON managed_publication_claims, managed_import_receipts TO ${watcher}`);
    await env.sql(`GRANT USAGE ON SEQUENCE managed_watch_settings_setting_id_seq, managed_watch_dispatches_dispatch_id_seq, managed_watch_findings_finding_id_seq TO ${watcher}`);
    await env.sql(`GRANT SELECT, INSERT ON managed_publication_claims, managed_import_receipts TO ${env.connection.user}`);
    const { pkg } = prepared;
    expect((await saveKohoImportPlan(drizzle(importer, { schema }), pkg.plan, true, "inserted", pkg.managed.sources, pkg.managed.receipt)).savedDocumentCount).toBe(4);
    const bytesByName = new Map<string, Buffer>();
    const db = drizzle(env.watchClient, { schema }), watch = new ManagedWatchRepository(db, async (_id, _category, name) => {
      const bytes = bytesByName.get(name); if (!bytes) throw Error("fixture_original_missing"); return { bytes, contentType: "application/xml" };
    }), deliveries = new ManagedDeliveryRepository(db);
    for (const sample of prepared.samples) {
      await env.sql("insert into cases(case_id,title) values($1,'FICTIONAL SAMPLE')", [sample.caseId]);
      const bytes = originals.find(o => o.caseId === sample.caseId)!.bytes, name = `cases/${sample.caseId}/prior-art/1700000000000-${randomUUID()}-fictional.xml`;
      bytesByName.set(name, bytes);
      const row = (await env.sql("insert into prior_art_documents(case_id,publication_no,title,claims_text,source_csv_row_json) values($1,null,'FICTIONAL XML',$2,$3) returning doc_id",
        [sample.caseId, bytes.toString(), JSON.stringify({ source: "uploaded-file", originalFileName: "fictional.xml", blobName: name, contentType: "application/xml", size: bytes.length })]))[0];
      await watch.saveSetting({ caseId: sample.caseId, contractSignedOn: "2026-08-01", monitoringStartsOn: period.from, contractEndsOn: "2026-10-31",
        enabled: true, base: sample.base, source: { ...sample.source, documentId: row.doc_id }, selectedClaimNos: [1] });
    }
    const run = await watch.prepare(1, period);
    expect(run.snapshot.scannedDocuments).toBe(4); expect(run.snapshot.incompleteDocuments).toBe(0); expect(run.snapshot.candidates.length).toBeGreaterThan(0);
    expect(run.snapshot.sourceKeys.length === 4 && prepared.manifest.records.every(r => run.snapshot.sourceKeys.includes(r.sourceKey))).toBe(true);
    const poisoned = structuredClone(run.snapshot); poisoned.setting.source.sha256 = prepared.manifest.records[1].originalXmlSha256;
    expect(() => assertTrialFictionalRun(p, poisoned)).toThrow("trial_fixture_unconfirmed");
    vi.stubEnv("TRIAL_RUNTIME_ROLE", "worker");
    const claimed = await watch.claimTrial(1, run.runId, "fictional-worker", run.snapshotDigest, iso(Date.now() + 10 * 60_000));
    const budget = { inputYenPerMillion: 500, outputYenPerMillion: 3000, maximumYen: 30000 };
    const request = (ordinal: number) => ({ ordinal, requestSha256: "d".repeat(64), estimatedInputTokens: 1000, maximumOutputTokens: 8192 });
    const screening = watch.journal(claimed, "screening", null, managedDigest(managedScreeningInput(claimed.snapshot)), budget);
    await screening.reserve(request(1)); await screening.reconcile({ ordinal: 1, inputTokens: 200, outputTokens: 40 });
    claimed.plan = await watch.saveScreening(claimed, [claimed.snapshot.candidates[0].candidateId]);
    for (const [index, chunk] of claimed.plan.chunks.entries()) {
      const journal = watch.journal(claimed, "detail", index, managedDigest(chunk), budget);
      await journal.reserve(request(index + 2)); await journal.reconcile({ ordinal: index + 2, inputTokens: 500, outputTokens: 100 });
      await watch.saveDetail(claimed, index, { results: chunk.pairs.map(pair => {
        const b = chunk.base.claims.find(c => c.claimNo === pair.baseClaimNo)!, c = chunk.candidate.claims.find(c => c.claimNo === pair.candidateClaimNo)!;
        return { ...pair, lexicalScore: 0.5, elementScore: 0.5, semanticScore: 0.5, structuralScore: 0.5, riskLabel: "Medium",
          baseEvidence: { claimNo: b.claimNo, start: 0, end: 4, quote: b.text.slice(0, 4) }, candidateEvidence: { claimNo: c.claimNo, start: 0, end: 4, quote: c.text.slice(0, 4) },
          explanation: "架空入力の一部要素が一致します。人による原文確認が必要です。" };
      }) });
    }
    await watch.finalize(claimed); vi.stubEnv("TRIAL_RUNTIME_ROLE", "web");
    const distribution = await deliveries.acquireDistribution(1);
    expect(distribution.sha256 === trialFictionalDigest(prepared.manifest)).toBe(true);
    expect((await env.sql("select source_url from managed_distribution_snapshots"))[0].source_url).toBe(TRIAL_FICTIONAL_SOURCE);
    const artifacts = memoryArtifacts(p.storage.account, p.storage.artifacts);
    const create = (reason: "initial" | "review_update") => createManagedDelivery(deliveries, artifacts.storage, { kind: "delivery", caseId: 1,
      deliveryId: randomUUID(), period, distributionTableSha256: distribution.sha256, reason, deliveredOn: null }, AbortSignal.timeout(90_000));
    const first = await create("initial"), saved = await deliveries.get(1, first.deliveryId);
    expect(first.provenance).toBe("fictional_trial"); expect(first.coverage.complete).toBe(true); expect(first.findings.length).toBeGreaterThan(0); expect(saved.status).toBe("stored");
    const oldBytes = new Map<string, Buffer>();
    for (const artifact of saved.manifest!.artifacts) { const bytes = await artifacts.storage.read(saved.manifest!, artifact.kind);
      expect(trialHash(bytes) === artifact.sha256 && bytes.length === artifact.bytes).toBe(true); oldBytes.set(artifact.kind, bytes); }
    const rows = parse(oldBytes.get("csv")!, { bom: true }) as string[][];
    expect(rows.every(row => row.length === 44)).toBe(true); expect(rows.length).toBeGreaterThan(1);
    expect(oldBytes.get("csv")!.toString().includes(FICTIONAL_TRIAL_NOTICE)).toBe(true);
    for (const [name, value] of Object.entries({ DOMMatrix, ImageData, Path2D })) vi.stubGlobal(name, value);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"), pdf = await getDocument({ data: new Uint8Array(oldBytes.get("pdf")!), useSystemFonts: false }).promise;
    let pdfText = "";
    try { for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) { const page = await pdf.getPage(pageNo);
      const text = (await page.getTextContent()).items.map(item => "str" in item ? item.str : "").join("").replace(/\s/g, "");
      expect(text.includes(`${pageNo}/${pdf.numPages}`)).toBe(true); pdfText += text; }
    } finally { await pdf.destroy(); }
    for (const text of [FICTIONAL_TRIAL_NOTICE, FICTIONAL_TRIAL_SOURCE_NOTICE, period.from, period.to, "候補#", "監視元請求項1"])
      expect(pdfText.includes(text.replace(/\s/g, ""))).toBe(true);
    const review = await watch.findingReview(1, first.findings[0].findingId), dispatches = await env.sql("select count(*)::int as n from managed_watch_dispatches");
    await watch.reviewFinding(1, review.findingId, true, review.reviewVersion);
    const second = await create("review_update"); expect(second.version).toBe(2); expect(second.previousDeliveryId).toBe(first.deliveryId);
    expect(second.findings[0].reviewStatus).toBe("reviewed");
    const reread = await deliveries.get(1, first.deliveryId); expect(reread.report.findings[0].reviewStatus).toBe("unreviewed");
    for (const artifact of reread.manifest!.artifacts) expect((await artifacts.storage.read(reread.manifest!, artifact.kind)).equals(oldBytes.get(artifact.kind)!)).toBe(true);
    expect((await env.sql("select count(*)::int as n from managed_watch_dispatches"))[0].n).toBe(dispatches[0].n);
    const unchanged = await watch.prepare(1, period); expect(unchanged.snapshot.sourceKeys.length).toBe(0); expect(() => assertTrialFictionalRun(p, unchanged.snapshot)).not.toThrow();
    const replacement = structuredClone(p); replacement.fictionalDistribution.packageSha256 = "e".repeat(64);
    for (const [key, value] of Object.entries(signedTrialEnvironment(replacement)).filter(([k]) => k !== "DATABASE_URL")) vi.stubEnv(key, value);
    await expect(deliveries.get(1, first.deliveryId)).rejects.toThrow("incomplete");
    for (const [key, value] of Object.entries(signed).filter(([k]) => k !== "DATABASE_URL")) vi.stubEnv(key, value);
    vi.setSystemTime(p.endsAt);
    // Operator reconciliation of existing bytes is permitted under its separate
    // ticket. New business operations still fail at the actual policy boundary.
    expect((await deliveries.get(1, first.deliveryId)).status).toBe("stored");
    await env.sql("update managed_watch_deliveries set status='storage_unknown' where delivery_id=$1", [first.deliveryId]);
    expect(await reconcileManagedDelivery(deliveries, artifacts.storage, 1, first.deliveryId, false, ledger)).toBe("stored");
    const privateHandler = vi.fn(async (_request: Request) => { void _request; return Response.json({ unexpected: true }); });
    for (const format of ["pdf", "csv"]) {
      const response = await withOwnerRoute(privateHandler)(new Request(`${p.auth.origin}/api/cases/1/managed-watch/deliveries/${first.deliveryId}/${format}`, { headers: trialHeaders() }));
      expect(response.status).toBe(403);
    }
    expect(privateHandler).not.toHaveBeenCalled();
    await expect(deliveries.acquireDistribution(1)).rejects.toThrow("trial_outside_period");
    await expect(deliveries.prepare(1, period, { distributionTableSha256: distribution.sha256 }, "review_update")).rejects.toThrow("trial_outside_period");
    vi.stubEnv("TRIAL_POLICY_SIGNATURE", "A".repeat(86) + "==");
    await expect(deliveries.get(1, first.deliveryId)).rejects.toThrow("trial_unavailable");
    expect(outsideNetwork).not.toHaveBeenCalled(); expect(artifacts.requests.filter(method => method === "PUT").length).toBe(6);
    process.stdout.write(JSON.stringify({ fixtureCompatibility: "passed", actualPrivateBytes: Boolean(directory), originals: 4, findings: first.findings.length, savedVersions: 2, cloudRequests: 0 }) + "\n");
  }, 180_000);
});
