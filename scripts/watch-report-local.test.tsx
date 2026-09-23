// Existing domain/renderer tests isolate authentication; owner-auth tests cover the real boundary.
vi.mock("@/lib/owner-http", () => ({ withOwnerRoute: (handler: unknown) => handler, requireOwner: async () => undefined }));
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { writeFile, readFile, readdir, mkdir, access, unlink } from "node:fs/promises";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedPg16, isolatedCommand } from "./watch-report-local.test-support";
import { manualFixture } from "./koho-manual-import-fixtures";
import { runPatentWatch } from "../src/lib/patent-watch/service";
import { AiOperationStopped } from "../src/lib/ai-operation-budget";
import { createPatentWatchHandlers, createPatentWatchRunHandlers, createPatentWatchFindingHandlers, createPatentWatchCsvHandlers } from "../src/lib/patent-watch/api";
import { readPeriodReport } from "../src/lib/patent-watch/period-report";
import type { PatentWatchAnalysisDependencies, CaseWatchRun } from "../src/lib/patent-watch/types";
import type { ExtractedClaims } from "../src/lib/extract-claims";
import RunPage from "../src/app/cases/[caseId]/watch/runs/[runId]/page";
import PeriodPage from "../src/app/cases/[caseId]/watch/period-report/page";

const seam = vi.hoisted(() => ({ db: undefined as NodePgDatabase | undefined }));
vi.mock("../src/db", () => ({ get db() { return seam.db; } }));
vi.mock("@/repositories", () => import("../src/repositories/drizzle"));
vi.mock("@/lib/patent-watch/domain", () => import("../src/lib/patent-watch/domain"));
vi.mock("@/lib/patent-watch/api", () => import("../src/lib/patent-watch/api"));
vi.mock("@/lib/patent-watch/period", () => import("../src/lib/patent-watch/period"));
vi.mock("@/lib/patent-watch/period-report", () => import("../src/lib/patent-watch/period-report"));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
import { caseRepo, draftPatentRepo, patentWatchRepo } from "../src/repositories/drizzle";

const CLAIMS: ExtractedClaims = { title: "完全架空の検証例", abstract: "架空試験", solvedProblems: [], effects: [],
  claims: [{ claimNo: 1, text: "架空装置の雲型パンと月面整列器", isIndependent: true, dependsOn: null,
    elements: [{ type: "component", text: "架空装置", importance: "core" }] }] };
const EXPLANATION = "完全架空の検証例・AI応答は固定。" + "この候補は架空の構成を比べるための長い日本語の説明です。構成要素の対応と異なる条件を順に確認し、原文との照合を行います。専門家の評価や実際のAI精度を示すものではありません。".repeat(5);
const context = (caseId: number) => ({ params: Promise.resolve({ caseId: String(caseId) }) });

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST !== "1")("watch report isolated PostgreSQL 16 integration (fixed fictional AI)", { timeout: 60_000 }, () => {
  let pg: Awaited<ReturnType<typeof isolatedPg16>> | undefined, server: Server | undefined;
  let caseA: number, caseB: number, first: CaseWatchRun, zero: CaseWatchRun, failed: CaseWatchRun;
  let aiCalls = 0, stopAi = false;
  let period: { from: string; to: string };
  const files: { packageType: "JPA" | "JPB"; path: string }[] = [];
  const watch = createPatentWatchHandlers({ repository: patentWatchRepo });
  const csv = createPatentWatchCsvHandlers({ repository: patentWatchRepo });
  const review = createPatentWatchFindingHandlers({ repository: patentWatchRepo });
  const ai: PatentWatchAnalysisDependencies = { repository: patentWatchRepo,
    screenPriorArt: async (_extracted, docs) => { aiCalls++; return { relevantDocIds: docs.map(doc => doc.docId), reasoning: "完全架空の固定応答" }; },
    analyzeOverlap: async (_extracted, docs) => {
      aiCalls++; if (stopAi) throw new AiOperationStopped();
      return docs.map(doc => ({ draftClaimNo: 1, priorDocId: doc.docId, lexicalScore: 0.6, elementScore: 0.5, semanticScore: 0.4, structuralScore: 0.3,
        matchedElements: ["完全架空の構成候補"], unmatchedElements: ["架空の条件差"], riskLabel: "Unknown" as const, explanation: EXPLANATION }));
    },
  };
  const runs = createPatentWatchRunHandlers({ executeRun: caseId => runPatentWatch(caseId, ai) });
  const get = (caseId: number) => watch.GET(new Request("http://127.0.0.1/watch"), context(caseId));
  const getCsv = (caseId: number, runId: number) => csv.GET(new Request(`http://127.0.0.1/report.csv?runId=${runId}`), context(caseId));
  const runHtml = async (caseId: number, runId: number) => renderToStaticMarkup(await RunPage({ params: Promise.resolve({ caseId: String(caseId), runId: String(runId) }) }));
  const snapshot = async () => JSON.stringify(await pg!.sql(`select
    (select json_agg(t order by import_id)::text from koho_import_runs t) as imports,
    (select json_agg(t order by document_id)::text from koho_import_documents t) as docs,
    (select json_agg(t order by watch_id)::text from case_watch_settings t) as settings,
    (select json_agg(t order by run_id)::text from case_watch_runs t) as runs,
    (select json_agg(t order by finding_id)::text from case_watch_findings t) as findings`));
  async function apply(selected: typeof files) {
    const { password: _password, ...expectedTarget } = pg!.connection; void _password;
    const result = await isolatedCommand(process.execPath, [resolve(".koho-ops/manual/scripts/koho-manual-import.js")], JSON.stringify({ mode: "apply",
      maxFileBytes: 1_000_000, maxTotalBytes: 4_000_000, files: selected, connection: pg!.connection, expectedTarget }));
    expect(result.stderr === "").toBe(true); expect(!result.output.includes(pg!.connection.password)).toBe(true);
    const parsed = JSON.parse(result.output); expect(parsed.exitCode).toBe(0); return parsed.results as { outcome: string }[];
  }
  async function fixtureCase(title: string) {
    const created = await caseRepo.create({ title });
    const draft = await draftPatentRepo.create({ caseId: created.caseId, sourceFilePath: "FICTIONAL-IN-MEMORY", parsedText: "完全架空" });
    await draftPatentRepo.updateExtractedClaims(draft.draftId, JSON.stringify(CLAIMS));
    const response = await watch.PUT(new Request("http://127.0.0.1/watch", { method: "PUT", body: JSON.stringify({ enabled: true, monitoringFromDate: "20990301" }) }), context(created.caseId));
    expect(response.status).toBe(200); return created.caseId;
  }
  beforeAll(async () => {
    pg = await isolatedPg16(); seam.db = drizzle(pg.watchClient);
    const compile = await isolatedCommand(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-manual-import.tsconfig.json"]);
    expect(compile.code === 0).toBe(true);
    for (const [packageType, count, changed] of [["JPA", 2, false], ["JPB", 2, false], ["JPA", 2, true], ["JPB", 3, false]] as const) {
      const path = join(pg.directory, `完全架空-${files.length}.zip`);
      await writeFile(path, manualFixture(packageType, count, { changed })); files.push({ packageType, path });
    }
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    period = { from: today, to: today };
    caseA = await fixtureCase("完全架空の検証例A・AI応答は固定"); caseB = await fixtureCase("完全架空の検証例B・AI応答は固定");
  }, 120_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await pg?.cleanup(); seam.db = undefined;
  }, 60_000);

  it("passes compiled preview/apply through real storage, watch, review and reports", async () => {
    const hook = join(pg!.directory, "preview.cjs");
    const require = createRequire(import.meta.url);
    await writeFile(hook, `let calls=0;
      require(${JSON.stringify(require.resolve("pg"))}).Client.prototype.connect=function(){calls++;throw Error('preview_connect_forbidden')};
      const cp=require('node:child_process'),fork=cp.fork;
      cp.fork=function(module,args,options){return fork(module,args,{...options,execArgv:[...(options?.execArgv??[]),'--require',__filename]})};
      process.on('exit',()=>require('node:fs').writeFileSync(require('node:path').join(__dirname,'preview-count-'+process.pid+'.txt'),String(calls)));`);
    const preview = await isolatedCommand(process.execPath, ["--require", hook, resolve(".koho-ops/manual/scripts/koho-manual-import.js")], JSON.stringify({ mode: "preview", maxFileBytes: 1_000_000, maxTotalBytes: 4_000_000, files: files.slice(0, 2) }));
    expect(JSON.parse(preview.output).exitCode).toBe(0);
    const counters = (await readdir(pg!.directory)).filter(name => /^preview-count-\d+\.txt$/.test(name));
    expect(counters).toHaveLength(3); // Parent and both actual parsing workers.
    for (const counter of counters) expect(await readFile(join(pg!.directory, counter), "utf8")).toBe("0");
    expect((await pg!.sql("select count(*)::int n from koho_import_documents"))[0].n).toBe(0);
    expect((await apply(files.slice(0, 2))).map(item => item.outcome)).toEqual(["inserted", "inserted"]);
    expect((await pg!.sql("select count(*)::int n from koho_import_documents"))[0].n).toBe(4);
    first = await runPatentWatch(caseA, ai); expect(first.newFindingCount).toBe(4);
    const other = await runPatentWatch(caseB, ai); expect(other.newFindingCount).toBe(4);
    const summary = await (await get(caseA)).json(); expect(summary.findings).toHaveLength(4);
    const findingId = summary.findings[0].findingId;
    const patch = await review.PATCH(new Request("http://127.0.0.1/finding", { method: "PATCH", body: JSON.stringify({ reviewStatus: "reviewed" }) }),
      { params: Promise.resolve({ caseId: String(caseA), findingId: String(findingId) }) });
    expect(patch.status).toBe(200);
    expect((await (await get(caseA)).json()).findings.find((f: { findingId: number }) => f.findingId === findingId).reviewStatus).toBe("reviewed");
    expect((await getCsv(caseA, first.runId)).status).toBe(200);
    expect((await getCsv(caseA, other.runId)).status).toBe(404);
    expect(await patentWatchRepo.updateFindingReviewStatus(caseB, findingId, "reviewed")).toBeNull();
    expect(await runHtml(caseA, first.runId)).toContain("確認済み");
    const report = await readPeriodReport(patentWatchRepo, caseA, period);
    expect(report.kind).toBe("ready"); if (report.kind !== "ready") throw Error("report_failed");
    expect(report.report.findings).toHaveLength(4); expect(report.report.summary.reviewed).toBe(1);
    expect(renderToStaticMarkup(await PeriodPage({ params: Promise.resolve({ caseId: String(caseA) }), searchParams: Promise.resolve(period) }))).toContain("新規候補数: 4件");
  });

  it("reuses ZIP without timestamp changes or extra AI, then analyzes only fresh content", async () => {
    const before = await snapshot(), calls = aiCalls;
    expect((await apply(files.slice(0, 2))).map(item => item.outcome)).toEqual(["reused", "reused"]);
    expect(await snapshot() === before).toBe(true);
    zero = await runPatentWatch(caseA, ai); expect(zero.newFindingCount).toBe(0); expect(aiCalls).toBe(calls);
    expect(await runHtml(caseA, zero.runId)).toContain("このrunで追加された確認候補はありません");
    expect((await (await get(caseA)).json()).unreviewedFindingCount).toBe(3);
    await apply([files[2]]); const fresh = await runPatentWatch(caseA, ai);
    expect(fresh.scannedDocumentCount).toBe(2); expect(fresh.newFindingCount).toBe(2); expect(aiCalls - calls).toBe(2);
    const report = await readPeriodReport(patentWatchRepo, caseA, period);
    if (report.kind !== "ready") throw Error("report_failed");
    expect(report.report.findings).toHaveLength(6); expect(new Set(report.report.findings.map(f => f.findingId)).size).toBe(6);
  });

  it("persists AI stop atomically, preserves cursor/history and recovers only on explicit next run", async () => {
    await apply([files[3]]);
    const setting = await patentWatchRepo.getSetting(caseA), count = (await (await get(caseA)).json()).findings.length;
    stopAi = true;
    const response = await runs.POST(new Request("http://127.0.0.1/run", { method: "POST" }), context(caseA));
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "watch_ai_stopped" });
    failed = (await patentWatchRepo.listRuns(caseA, 1))[0]; expect(failed.status).toBe("failed");
    const after = await patentWatchRepo.getSetting(caseA);
    expect(after?.cursorImportId).toBe(setting?.cursorImportId); expect(after?.cursorRunUpdatedAt).toBe(setting?.cursorRunUpdatedAt);
    expect((await (await get(caseA)).json()).findings.length).toBe(count);
    expect(await patentWatchRepo.listFindings(caseA, { runId: failed.runId, limit: 100 })).toHaveLength(0);
    const csvResponse = await getCsv(caseA, failed.runId); expect(csvResponse.status).toBe(409); expect(csvResponse.headers.has("content-disposition")).toBe(false);
    expect(await runHtml(caseA, failed.runId)).toContain("結果は未確定");
    stopAi = false; const recovered = await runPatentWatch(caseA, ai); expect(recovered.newFindingCount).toBe(1);
    expect((await patentWatchRepo.getRun(caseA, failed.runId))?.status).toBe("failed");
    const report = await readPeriodReport(patentWatchRepo, caseA, period);
    if (report.kind !== "ready") throw Error("report_failed");
    expect(report.report.summary.failed).toBe(1); expect(report.report.findings).toHaveLength(7);
  });

  it("proves real SQL case/JST microsecond bounds, read-only snapshot consistency, caps and corrupt-row rejection", async () => {
    const boundary = await fixtureCase("完全架空の境界negative control");
    const setting = await patentWatchRepo.getSetting(boundary), watchId = setting!.watchId;
    const times = ["2096-02-29 14:59:59.999999+00", "2096-02-29 15:00:00.000000+00", "2096-03-01 14:59:59.999999+00", "2096-03-01 15:00:00.000000+00"];
    for (const time of times) await pg!.sql("insert into case_watch_runs(watch_id,status,monitoring_from_date,started_at) values($1,'running','20960301',$2)", [watchId, time]);
    const bounds = { from: "2096-03-01", to: "2096-03-01" };
    seam.db = drizzle(pg!.reportClient);
    const before = await snapshot(), calls = aiCalls;
    const selected = await patentWatchRepo.readPeriodSnapshot(boundary, bounds);
    expect(selected?.runs).toHaveLength(2);
    expect(selected?.runs[1].startedAt).toContain("999999");
    const running = selected!.runs[0]; expect(await runHtml(boundary, running.runId)).toContain("実行中");
    expect((await getCsv(boundary, running.runId)).status).toBe(409);
    expect(await snapshot() === before).toBe(true); expect(aiCalls).toBe(calls);
    // Observe only the real query boundary; do not fabricate any SQL result.
    const query = pg!.reportClient.query.bind(pg!.reportClient);
    let barrier = true, observedReadOnly = false;
    pg!.reportClient.query = (async (...args: unknown[]) => {
      const result = await (query as (...values: unknown[]) => Promise<unknown>)(...args);
      const statement = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (barrier && statement.includes("transaction_timestamp()")) {
        barrier = false;
        const mode = await query("show transaction_read_only"); observedReadOnly = mode.rows[0].transaction_read_only === "on";
        await pg!.sql("update case_watch_findings set review_status='unreviewed' where watch_id=$1 and review_status='reviewed'", [first.watchId]);
      }
      return result;
    }) as Client["query"];
    try {
      const consistent = await readPeriodReport(patentWatchRepo, caseA, period);
      if (consistent.kind !== "ready") throw Error("snapshot_failed");
      expect(consistent.report.summary.reviewed).toBe(1); expect(observedReadOnly).toBe(true);
    } finally { pg!.reportClient.query = query; }
    const next = await readPeriodReport(patentWatchRepo, caseA, period);
    if (next.kind !== "ready") throw Error("snapshot_failed"); expect(next.report.summary.reviewed).toBe(0);
    await pg!.sql("update case_watch_findings set review_status='reviewed' where finding_id=(select max(finding_id) from case_watch_findings where first_run_id=$1)", [first.runId]);
    // Negative controls are isolated from service-produced evidence.
    await pg!.sql("insert into case_watch_runs(watch_id,status,monitoring_from_date,started_at) select $1,'running','20960301','2096-03-02 00:00:00+00' from generate_series(1,200)", [watchId]);
    const capPeriod = { from: "2096-03-02", to: "2096-03-02" };
    // The upper-boundary control above also belongs to this day; use a separate day.
    await pg!.sql("update case_watch_runs set started_at='2096-03-03 00:00:00+00' where watch_id=$1 and started_at='2096-03-02 00:00:00+00'", [watchId]);
    capPeriod.from = capPeriod.to = "2096-03-03";
    expect((await readPeriodReport(patentWatchRepo, boundary, capPeriod)).kind).toBe("ready");
    await pg!.sql("insert into case_watch_runs(watch_id,status,monitoring_from_date,started_at) values($1,'running','20960301','2096-03-03 00:00:00+00')", [watchId]);
    expect((await readPeriodReport(patentWatchRepo, boundary, capPeriod)).kind).toBe("too_many");
    const [capRun] = await pg!.sql("insert into case_watch_runs(watch_id,status,monitoring_from_date,started_at,completed_at,new_finding_count) values($1,'completed','20960301','2096-03-04 00:00:00+00','2096-03-04 00:00:01+00',4000) returning run_id", [watchId]);
    await pg!.sql(`insert into case_watch_findings(watch_id,source_key,first_run_id,package_type,kind,publication_number,publication_date,invention_title,lexical_score,element_score,semantic_score,structural_score,risk_label,analysis_json,analysis_mode,review_status,first_seen_at)
      select $1,md5(n::text)||md5(n::text),$2,'JPA','A1','FICTIONAL-'||n,'20960301','完全架空の上限',0,0,0,0,'Unknown','{"matchedElements":[],"unmatchedElements":[],"explanation":"完全架空"}','ai','unreviewed','2096-03-04 00:00:01+00' from generate_series(1,4000) n`, [watchId, capRun.run_id]);
    const findingPeriod = { from: "2096-03-04", to: "2096-03-04" };
    expect((await readPeriodReport(patentWatchRepo, boundary, findingPeriod)).kind).toBe("ready");
    await pg!.sql(`insert into case_watch_findings(watch_id,source_key,first_run_id,package_type,kind,publication_number,publication_date,invention_title,lexical_score,element_score,semantic_score,structural_score,risk_label,analysis_json,analysis_mode,review_status,first_seen_at)
      select watch_id,repeat('f',64),first_run_id,package_type,kind,'FICTIONAL-EXCESS',publication_date,invention_title,0,0,0,0,risk_label,analysis_json,analysis_mode,review_status,first_seen_at from case_watch_findings where first_run_id=$1 limit 1`, [capRun.run_id]);
    expect((await readPeriodReport(patentWatchRepo, boundary, findingPeriod)).kind).toBe("too_many");
    await pg!.sql("update case_watch_runs set new_finding_count=100 where run_id=$1", [capRun.run_id]);
    expect((await getCsv(boundary, capRun.run_id)).status).toBe(503); // 101st-row sentinel.
    const [bad] = await pg!.sql("select finding_id,analysis_json from case_watch_findings where first_run_id=$1 limit 1", [first.runId]);
    await pg!.sql("update case_watch_findings set analysis_json='FICTIONAL_PRIVATE_SENTINEL' where finding_id=$1", [bad.finding_id]);
    expect((await getCsv(caseA, first.runId)).status).toBe(503);
    expect(await runHtml(caseA, first.runId)).toContain("データ取得不能");
    await pg!.sql("update case_watch_findings set analysis_json=$1 where finding_id=$2", [bad.analysis_json, bad.finding_id]);
    seam.db = drizzle(pg!.watchClient);
  });

  it.skipIf(process.env.WATCH_REPORT_BROWSER !== "1")("serves actual DB handlers/pages on loopback for visual and PDF acceptance", async () => {
    const require = createRequire(import.meta.url);
    const esbuild = require(require.resolve("esbuild", { paths: [require.resolve("vitest/node")] }));
    const bundle = await esbuild.build({ entryPoints: [resolve("scripts/watch-report-browser.test-support.tsx")], bundle: true, write: false,
      platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
    const postcss = require(require.resolve("postcss", { paths: [require.resolve("@tailwindcss/postcss")] }));
    const tailwind = require("@tailwindcss/postcss");
    const css = (await postcss([tailwind()]).process(await readFile("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") })).css;
    const out = resolve(".koho-ops/issue101"); await mkdir(out, { recursive: true });
    const finishFile = `finish-browser-${randomBytes(8).toString("hex")}`;
    const marker = join(out, finishFile); let posts = 0, gets = 0;
    stopAi = true; // B has pending new corpus; only an explicit UI POST consumes this stop.
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, "http://127.0.0.1"), path = url.pathname;
        const requestBody: Buffer[] = []; for await (const chunk of req) requestBody.push(Buffer.from(chunk));
        const request = new Request(url, { method: req.method, ...(requestBody.length ? { body: Buffer.concat(requestBody) } : {}) });
        let response: Response | undefined;
        const route = /^\/api\/cases\/(\d+)\/watch(?:\/(.*))?$/.exec(path);
        if (route) {
          const caseId = Number(route[1]), action = route[2] ?? "";
          if (action === "" && req.method === "GET") { gets++; response = await get(caseId); }
          if (action === "runs" && req.method === "POST") { posts++; response = await runs.POST(request, context(caseId)); stopAi = false; }
          if (action === "report.csv") response = await csv.GET(request, context(caseId));
          if (/^findings\/\d+$/.test(action) && req.method === "PATCH") response = await review.PATCH(request, { params: Promise.resolve({ caseId: String(caseId), findingId: action.split("/")[1] }) });
        }
        if (response) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return; }
        if (path === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
        if (path === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); return; }
        if (path === "/metrics") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ posts, gets, externalAi: 0 })); return; }
        let html = "", props: unknown;
        const single = /^\/cases\/(\d+)\/watch\/runs\/(\d+)$/.exec(path);
        const aggregate = /^\/cases\/(\d+)\/watch\/period-report$/.exec(path);
        const casePath = /^\/cases\/(\d+)$/.exec(path);
        if (single) html = (await runHtml(Number(single[1]), Number(single[2]))).replace('<button type="button"', '<button data-harness-print type="button"');
        else if (aggregate) {
          const caseId = Number(aggregate[1]);
          const selected: Record<string, string | string[]> = {};
          for (const key of new Set(url.searchParams.keys())) {
            const values = url.searchParams.getAll(key); selected[key] = values.length === 1 ? values[0] : values;
          }
          const page = await PeriodPage({ params: Promise.resolve({ caseId: String(caseId) }), searchParams: Promise.resolve(selected) });
          html = renderToStaticMarkup(page); props = { ...page.props, view: "period" };
        } else if (casePath) props = { caseId: Number(casePath[1]), view: "case" };
        else html = `<main><h1>完全架空の検証例・AI応答は固定</h1><ul>${[
          ["候補あり", `/cases/${caseA}/watch/runs/${first.runId}`], ["正常0件", `/cases/${caseA}/watch/runs/${zero.runId}`],
          ["失敗", `/cases/${caseA}/watch/runs/${failed.runId}`], ["失敗混在・期間レポート", `/cases/${caseA}/watch/period-report?from=${period.from}&to=${period.to}`],
          ["未実行期間", `/cases/${caseA}/watch/period-report?from=2096-04-01&to=2096-04-01`], ["ケースB・実操作", `/cases/${caseB}`],
        ].map(([label, href]) => `<li><a href="${href}">${label}</a></li>`).join("")}</ul></main>`;
        const data = JSON.stringify(props ?? null).replaceAll("<", "\\u003c");
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
        res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>完全架空の検証例・AI応答は固定</title><link rel="stylesheet" href="/style.css"><body><p style="padding:12px;border:2px solid #4f46e5">完全架空の検証例・AI応答は固定。実AI・本番・顧客データ使用0。</p>${props ? `<div id="interactive">${html}</div><script id="fixture-props" type="application/json">${data}</script>` : html}<script src="/bundle.js"></script></body></html>`);
      } catch { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }); res.end("架空試験の取得不能"); }
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw Error("loopback_failed");
    await writeFile(join(out, "browser.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, finishFile, caseA, caseB, first: first.runId, zero: zero.runId, failed: failed.runId, period }));
    console.log("ISSUE101_LOOPBACK_READY");
    for (let n = 0; n < 1800; n++) { if (await access(marker).then(() => true, () => false)) { await unlink(marker); return; } await new Promise(done => setTimeout(done, 1000)); }
    throw Error("loopback_acceptance_timeout");
  }, 1_850_000);
});
