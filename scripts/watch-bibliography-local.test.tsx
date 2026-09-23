// Existing domain/renderer tests isolate authentication; owner-auth tests cover the real boundary.
vi.mock("@/lib/owner-http", () => ({ withOwnerRoute: (handler: unknown) => handler, requireOwner: async () => undefined }));
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { writeFile, readFile, mkdir, access, unlink } from "node:fs/promises";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedPg16, isolatedCommand } from "./watch-report-local.test-support";
import { buildZip } from "../src/lib/koho-zip/__fixtures__/zip-builder";
import { buildFictionalFullPublicationXml } from "../src/lib/koho-xml/__fixtures__/fictional-koho";
import { fictionalAbstractCsv, fictionalContents1Csv, fictionalContents2Csv } from "../src/lib/koho-package/__fixtures__/fictional-package";
import { runPatentWatch } from "../src/lib/patent-watch/service";
import { createPatentWatchHandlers } from "../src/lib/patent-watch/api";
import { readFindingBibliography } from "../src/lib/patent-watch/bibliography";
import type { PatentWatchAnalysisDependencies } from "../src/lib/patent-watch/types";
import type { ExtractedClaims } from "../src/lib/extract-claims";
import Page from "../src/app/cases/[caseId]/watch/findings/[findingId]/page";
import RunPage from "../src/app/cases/[caseId]/watch/runs/[runId]/page";
import PeriodPage from "../src/app/cases/[caseId]/watch/period-report/page";

const seam = vi.hoisted(() => ({ db: undefined as NodePgDatabase | undefined }));
vi.mock("../src/db", () => ({ get db() { return seam.db; } }));
vi.mock("@/repositories", () => import("../src/repositories/drizzle"));
vi.mock("@/lib/patent-watch/domain", () => import("../src/lib/patent-watch/domain"));
vi.mock("@/lib/patent-watch/api", () => import("../src/lib/patent-watch/api"));
vi.mock("@/lib/patent-watch/period", () => import("../src/lib/patent-watch/period"));
vi.mock("@/lib/patent-watch/period-report", () => import("../src/lib/patent-watch/period-report"));
vi.mock("@/lib/patent-watch/bibliography", () => import("../src/lib/patent-watch/bibliography"));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
import { caseRepo, draftPatentRepo, patentWatchRepo } from "../src/repositories/drizzle";

const LONG_NAME = "完全架空の長い出願人名" + "架空研究開発部門".repeat(38) + "FICTIONAL".repeat(15);
const CLAIMS: ExtractedClaims = { title: "完全架空", abstract: "架空試験", solvedProblems: [], effects: [], claims: [{ claimNo: 1,
  text: "架空装置の雲型パンと月面整列器", isIndependent: true, dependsOn: null, elements: [{ type: "component", text: "架空装置", importance: "core" }] }] };
function fixture(type: "JPA" | "JPB") {
  const section = type === "JPA" ? "P_A1" : "P_B1", kind = type === "JPA" ? "A1" : "B1", number = type === "JPA" ? "2099000101" : "9999901";
  return buildZip({ entries: [
    { fileName: "ABSTRACT.csv", data: fictionalAbstractCsv(type) },
    { fileName: "DOCUMENT_LIST.csv", data: `JP,${number},${type === "JPA" ? "A" : "B1"},20990311\r\n` },
    { fileName: `DOCUMENT/${section}/CONTENTS1.csv`, data: fictionalContents1Csv(type, number) },
    { fileName: `DOCUMENT/${section}/CONTENTS2.csv`, data: fictionalContents2Csv(type, number) },
    { fileName: `DOCUMENT/${section}/999900/999990/${number}/${number}.xml`, data: buildFictionalFullPublicationXml(kind, {
      publicationNumber: number, publicationDate: "2099-03-11", applicationNumber: "2098000001", abstract: null,
      inventionTitle: "完全架空の書誌検証用発明", applicants: [{ sequenceNumber: "1", names: [LONG_NAME] }, { sequenceNumber: "2", names: ["架空 太郎"] }],
    }) },
  ] }).bytes;
}

describe.skipIf(process.env.WATCH_BIBLIOGRAPHY_LOCAL_DB_TEST !== "1")("Issue103 isolated PG16 bibliography (fictional fixed AI)", { timeout: 60_000 }, () => {
  let pg: Awaited<ReturnType<typeof isolatedPg16>> | undefined, server: Server | undefined;
  let caseA: number, caseB: number, runId: number, findingId: number, documentId: number;
  let aiCalls = 0;
  const ai: PatentWatchAnalysisDependencies = { repository: patentWatchRepo,
    screenPriorArt: async (_claims, docs) => { aiCalls++; return { relevantDocIds: docs.map(d => d.docId), reasoning: "架空固定応答" }; },
    analyzeOverlap: async (_claims, docs) => { aiCalls++; return docs.map(d => ({ draftClaimNo: 1, priorDocId: d.docId, lexicalScore: .5, elementScore: .5,
      semanticScore: .5, structuralScore: .5, matchedElements: ["架空構成"], unmatchedElements: ["架空差分"], riskLabel: "Unknown" as const, explanation: "完全架空の固定AI比較" })); },
  };
  const snapshot = async () => JSON.stringify(await pg!.sql(`select
    (select json_agg(t order by case_id) from cases t) as cases,
    (select json_agg(t order by draft_id) from draft_patents t) as drafts,
    (select json_agg(t order by import_id) from koho_import_runs t) as imports,
    (select json_agg(t order by document_id) from koho_import_documents t) as documents,
    (select json_agg(t order by watch_id) from case_watch_settings t) as settings,
    (select json_agg(t order by run_id) from case_watch_runs t) as runs,
    (select json_agg(t order by finding_id) from case_watch_findings t) as findings`));
  const read = (id = findingId, caseId = caseA) => readFindingBibliography(patentWatchRepo, caseId, id);
  beforeAll(async () => {
    pg = await isolatedPg16(103); seam.db = drizzle(pg.watchClient);
    expect((await isolatedCommand(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-manual-import.tsconfig.json"])).code === 0).toBe(true);
    const files = [];
    for (const type of ["JPA", "JPB"] as const) { const path = join(pg.directory, `fictional-${type}.zip`); await writeFile(path, fixture(type)); files.push({ packageType: type, path }); }
    const { password: _password, ...expectedTarget } = pg.connection; void _password;
    const imported = await isolatedCommand(process.execPath, [resolve(".koho-ops/manual/scripts/koho-manual-import.js")], JSON.stringify({ mode: "apply",
      maxFileBytes: 1_000_000, maxTotalBytes: 4_000_000, allowReviewRequired: true, files, connection: pg.connection, expectedTarget }));
    expect(imported.stderr === "").toBe(true); expect(JSON.parse(imported.output).exitCode).toBe(0);
    caseA = (await caseRepo.create({ title: "完全架空書誌A" })).caseId; caseB = (await caseRepo.create({ title: "完全架空書誌B" })).caseId;
    const draft = await draftPatentRepo.create({ caseId: caseA, sourceFilePath: "FICTIONAL-IN-MEMORY", parsedText: "完全架空" });
    await draftPatentRepo.updateExtractedClaims(draft.draftId, JSON.stringify(CLAIMS));
    await patentWatchRepo.upsertSetting(caseA, { enabled: true, monitoringFromDate: "20990301" });
    const run = await runPatentWatch(caseA, ai); expect(run.newFindingCount).toBe(2); runId = run.runId;
    const [finding] = await pg.sql("select finding_id,corpus_document_id from case_watch_findings where kind='A1'");
    findingId = finding.finding_id; documentId = finding.corpus_document_id;
    seam.db = drizzle(pg.reportClient);
  }, 120_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await pg?.cleanup(); seam.db = undefined;
  }, 60_000);
  it("reads real CLI-created JPA/JPB with all names and a shared application, without changing any row", async () => {
    const before = await snapshot(), calls = aiCalls;
    const findings = await patentWatchRepo.listFindings(caseA, { limit: 100 });
    for (const f of findings) {
      const result = await read(f.findingId); expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw Error("no_bibliography");
      expect(result.finding.bibliography).toMatchObject({ applicationNumber: { value: "2098000001" }, publicationDate: "20990311", reviewRequired: true,
        applicants: { state: "available", value: [[LONG_NAME], ["架空 太郎"]] } });
      expect(JSON.stringify(result)).not.toMatch(/sourceKey|contentSha256|documentId|applicantsJson|sourceValue/);
    }
    expect(await snapshot() === before).toBe(true); expect(aiCalls).toBe(calls);
    expect((await read(findingId, caseB)).kind).toBe("not_found"); expect((await read(2_147_483_647)).kind).toBe("not_found");
    await expect(Page({ params: Promise.resolve({ caseId: String(caseB), findingId: String(findingId) }) })).rejects.toThrow("NOT_FOUND");
  });
  it("withholds unrelated/missing/version-changed references and oversized/invalid applicant JSON", async () => {
    const [other] = await pg!.sql("select document_id from koho_import_documents where document_id<>$1", [documentId]);
    for (const reference of [other.document_id, null]) {
      await pg!.sql("update case_watch_findings set corpus_document_id=$1 where finding_id=$2", [reference, findingId]);
      const before = await snapshot(), result = await read();
      expect(result.kind === "ready" && result.finding.bibliography === null).toBe(true); expect(await snapshot() === before).toBe(true);
    }
    await pg!.sql("update case_watch_findings set corpus_document_id=$1 where finding_id=$2", [documentId, findingId]);
    const [original] = await pg!.sql("select content_sha256,applicants_json from koho_import_documents where document_id=$1", [documentId]);
    await pg!.sql("update koho_import_documents set content_sha256=$1 where document_id=$2", ["b".repeat(64), documentId]);
    const mismatch = await read(); expect(mismatch.kind === "ready" && mismatch.finding.bibliography === null).toBe(true);
    await pg!.sql("update koho_import_documents set content_sha256=$1 where document_id=$2", [original.content_sha256, documentId]);
    for (const applicants of ["broken", " ".repeat(65_537)]) {
      await pg!.sql("update koho_import_documents set applicants_json=$1 where document_id=$2", [applicants, documentId]);
      const result = await read(); expect(result.kind === "ready" && result.finding.bibliography?.applicants.state === "unavailable").toBe(true);
    }
    await pg!.sql("update koho_import_documents set applicants_json=$1 where document_id=$2", [original.applicants_json, documentId]);
  });
  it("fails boundedly under a real lock without publishing DB errors or changing rows", async () => {
    const before = await snapshot();
    await pg!.sql("begin"); await pg!.sql("lock table koho_import_documents in access exclusive mode");
    try { expect(await read()).toEqual({ kind: "unavailable" }); }
    finally { await pg!.sql("rollback"); }
    expect(await snapshot() === before).toBe(true);
  });
  it.skipIf(process.env.WATCH_BIBLIOGRAPHY_BROWSER !== "1")("serves actual read-only pages/components for browser and printed PDF acceptance", async () => {
    const require = createRequire(import.meta.url);
    const esbuild = require(require.resolve("esbuild", { paths: [require.resolve("vitest/node")] }));
    const bundle = await esbuild.build({ entryPoints: [resolve("scripts/watch-bibliography-browser.test-support.tsx")], bundle: true, write: false,
      platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
    const postcss = require(require.resolve("postcss", { paths: [require.resolve("@tailwindcss/postcss")] }));
    const css = (await postcss([require("@tailwindcss/postcss")()]).process(await readFile("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") })).css;
    const out = resolve(".koho-ops/issue103"); await mkdir(out, { recursive: true });
    const finishFile = `finish-browser-${randomBytes(8).toString("hex")}`, marker = join(out, finishFile);
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()), period = { from: today, to: today };
    let reads = 0, writes = 0;
    const before = await snapshot(), watch = createPatentWatchHandlers({ repository: patentWatchRepo });
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, "http://127.0.0.1"), path = url.pathname;
        if (req.method !== "GET") { writes++; res.writeHead(405); res.end(); return; }
        if (path === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
        if (path === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); return; }
        if (path === "/metrics") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ reads, writes, externalAi: 0 })); return; }
        const status = /^\/api\/cases\/(\d+)\/watch$/.exec(path);
        if (status) { const response = await watch.GET(new Request(url), { params: Promise.resolve({ caseId: status[1] }) }); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return; }
        const finding = /^\/cases\/(\d+)\/watch\/findings\/([^/]+)$/.exec(path), single = /^\/cases\/(\d+)\/watch\/runs\/(\d+)$/.exec(path), aggregate = /^\/cases\/(\d+)\/watch\/period-report$/.exec(path), casePath = /^\/cases\/(\d+)$/.exec(path);
        let html = "", props: unknown;
        if (finding) { reads++; const page = await Page({ params: Promise.resolve({ caseId: finding[1], findingId: finding[2] }) }); html = renderToStaticMarkup(page); props = { ...page.props, view: "bibliography" }; }
        else if (single) html = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ caseId: single[1], runId: single[2] }) }));
        else if (aggregate) { const page = await PeriodPage({ params: Promise.resolve({ caseId: aggregate[1] }), searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }); html = renderToStaticMarkup(page); props = { ...page.props, view: "period" }; }
        else if (casePath) props = { caseId: Number(casePath[1]), view: "case" };
        else html = `<main><h1>完全架空の書誌検証</h1><a href="/cases/${caseA}">候補一覧</a><br><a href="/cases/${caseA}/watch/runs/${runId}">単一run</a><br><a href="/cases/${caseA}/watch/period-report?from=${today}&to=${today}">期間report</a><br><a href="/cases/${caseA}/watch/findings/${findingId}?clipboard=deny">コピー拒否の検証</a></main>`;
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
        res.end(`<!doctype html><html lang="ja" data-clipboard="${url.searchParams.get("clipboard") === "deny" ? "deny" : "normal"}"><meta charset="utf-8"><title>完全架空の書誌検証</title><link rel="stylesheet" href="/style.css"><body><p class="print-hidden">完全架空の検証例・外部AIと本番接続0</p>${props ? `<div id="interactive">${html}</div><script id="fixture-props" type="application/json">${JSON.stringify(props).replaceAll("<", "\\u003c")}</script>` : html}<script src="/bundle.js"></script></body></html>`);
      } catch (error) { res.writeHead(error instanceof Error && error.message === "NOT_FOUND" ? 404 : 503); res.end("検証画面を取得できません"); }
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw Error("loopback_failed");
    await writeFile(join(out, "browser.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, finishFile, caseA, caseB, findingId, runId, period }));
    console.log("ISSUE103_LOOPBACK_READY");
    for (let n = 0; n < 1800; n++) {
      if (await access(marker).then(() => true, () => false)) { await unlink(marker); expect(writes).toBe(0); expect(await snapshot() === before).toBe(true); return; }
      await new Promise(done => setTimeout(done, 1000));
    }
    throw Error("loopback_acceptance_timeout");
  }, 1_850_000);
});
