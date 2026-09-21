import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { writeFile, readFile, mkdir, access, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { renderToStaticMarkup } from "react-dom/server";
import { createAzure } from "@ai-sdk/azure";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedPg16, isolatedCommand } from "./watch-report-local.test-support";
import { manualFixture } from "./koho-manual-import-fixtures";
import { boundedAzureFetch } from "../src/lib/ai-operation-budget";
import { createPatentWatchHandlers, createPatentWatchFindingHandlers, createPatentWatchCsvHandlers } from "../src/lib/patent-watch/api";
import type { CaseWatchRun } from "../src/lib/patent-watch/types";

const seam = vi.hoisted(() => ({ db: undefined as NodePgDatabase | undefined, blobs: new Map<string, Buffer>() }));
vi.mock("../src/db", () => ({ get db() { return seam.db; } }));
vi.mock("@/repositories", () => import("../src/repositories/drizzle"));
vi.mock("@/lib/parse-file", () => import("../src/lib/parse-file"));
vi.mock("@/lib/document-intelligence", () => import("../src/lib/document-intelligence"));
vi.mock("@/lib/extract-claims", () => import("../src/lib/extract-claims"));
vi.mock("@/lib/analyze-overlap", () => import("../src/lib/analyze-overlap"));
vi.mock("@/lib/ai-operation-budget", () => import("../src/lib/ai-operation-budget"));
vi.mock("@/lib/original-file-metadata", () => import("../src/lib/original-file-metadata"));
vi.mock("@/lib/patent-watch/service", () => import("../src/lib/patent-watch/service"));
vi.mock("@/lib/patent-watch/domain", () => import("../src/lib/patent-watch/domain"));
vi.mock("@/lib/patent-watch/api", () => import("../src/lib/patent-watch/api"));
vi.mock("@/lib/patent-watch/period", () => import("../src/lib/patent-watch/period"));
vi.mock("@/lib/patent-watch/period-report", () => import("../src/lib/patent-watch/period-report"));
vi.mock("@/lib/patent-watch/bibliography", () => import("../src/lib/patent-watch/bibliography"));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
vi.mock("@/lib/blob-storage", async () => ({
  ...(await import("../src/lib/original-file-metadata")),
  storeOriginalFile: async (input: { caseId: number; buffer: Buffer }) => {
    const blobName = `cases/${input.caseId}/drafts/main/fictional.txt`;
    seam.blobs.set(blobName, Buffer.from(input.buffer)); return { blobName };
  },
  deleteOriginalFiles: async (names: string[]) => {
    const deleted = names.filter(name => seam.blobs.delete(name)).length;
    return { attempted: names.length, deleted, failed: [], skipped: false };
  },
}));
vi.mock("../src/lib/ai-model", () => ({
  getModel: () => createAzure({ baseURL: "https://example.invalid/openai", apiKey: "fictional", apiVersion: "v1", fetch: boundedAzureFetch("normal") })("fictional"),
  getFastModel: () => createAzure({ baseURL: "https://example.invalid/openai", apiKey: "fictional", apiVersion: "v1", fetch: boundedAzureFetch("fast") })("fictional"),
  aiProviderRetries: () => 0, getGoogleThinkingProviderOptions: () => undefined,
}));
import { caseRepo, patentWatchRepo } from "../src/repositories/drizzle";
import { POST as createCase } from "../src/app/api/cases/route";
import { POST as upload, GET as drafts } from "../src/app/api/cases/[caseId]/draft/route";
import { POST as extract } from "../src/app/api/cases/[caseId]/draft/[draftId]/extract/route";
import { POST as run } from "../src/app/api/cases/[caseId]/watch/runs/route";
import { DELETE as removeCase, GET as getCase } from "../src/app/api/cases/[caseId]/route";
import RunPage from "../src/app/cases/[caseId]/watch/runs/[runId]/page";
import PeriodPage from "../src/app/cases/[caseId]/watch/period-report/page";
import BibliographyPage from "../src/app/cases/[caseId]/watch/findings/[findingId]/page";

const TXT = "【発明の名称】完全架空の検証用発明\n【請求項１】架空装置の雲型パンと月面整列器。\n";
const CLAIMS = { title: "完全架空の検証用発明", abstract: "完全架空の検証例", solvedProblems: [], effects: [],
  claims: [{ claimNo: 1, text: "架空装置の雲型パンと月面整列器", isIndependent: true, dependsOn: null,
    elements: [{ type: "component", text: "架空装置", importance: "core" }] }] };
const EXPLANATION = "完全架空・固定応答。" + "構成要素の対応と異なる条件を原文で確認してください。実AIの精度評価ではありません。".repeat(20);
const ctx = (caseId: number) => ({ params: Promise.resolve({ caseId: String(caseId) }) });
const req = (path: string, method = "GET", body?: string) => new Request(`http://127.0.0.1/${path}`, { method, body });

describe.skipIf(process.env.WATCH_COMPLETION_LOCAL_TEST !== "1")("Issue125 fictional full flow with real PG16/repository/SDK and isolated external transports", () => {
  let pg: Awaited<ReturnType<typeof isolatedPg16>> | undefined, server: Server | undefined;
  let caseId: number, first: CaseWatchRun, second: CaseWatchRun, zero: CaseWatchRun, failed: CaseWatchRun;
  let sends = 0, stopDetail = false, zeroSelection = false, from = "", to = "";
  const files: { packageType: "JPA" | "JPB"; path: string }[] = [];
  const out = resolve(".koho-ops/issue125");
  const watch = createPatentWatchHandlers({ repository: patentWatchRepo });
  const review = createPatentWatchFindingHandlers({ repository: patentWatchRepo });
  const csv = createPatentWatchCsvHandlers({ repository: patentWatchRepo });
  const status = () => watch.GET(req("watch"), ctx(caseId));
  const post = () => run(req("watch/runs", "POST"), ctx(caseId));
  const corpusSnapshot = async () => JSON.stringify(await pg!.sql("select d.document_id,d.content_sha256,r.updated_at from koho_import_documents d join koho_import_runs r using(import_id) order by d.document_id"));
  async function apply(indexes: number[]) {
    const { password: _password, ...expectedTarget } = pg!.connection; void _password;
    const result = await isolatedCommand(process.execPath, [resolve(".koho-ops/manual/scripts/koho-manual-import.js")], JSON.stringify({ mode: "apply",
      maxFileBytes: 1_000_000, maxTotalBytes: 4_000_000, files: indexes.map(i => files[i]), connection: pg!.connection, expectedTarget }));
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.output); expect(parsed.exitCode).toBe(0);
    return parsed.results.map((item: { outcome: string }) => item.outcome);
  }
  beforeAll(async () => {
    vi.stubEnv("AI_PROVIDER", "azure"); vi.stubEnv("WATCH_REPORT_LOCAL_DB_TEST", "1");
    vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
      if (!String(url).startsWith("https://example.invalid/openai/")) throw Error("external_transport_forbidden");
      sends++;
      const body = JSON.parse(String(init.body)), schema = body.text.format.schema.properties;
      const input = schema.claims ? null : JSON.parse(body.input[1].content[0].text);
      let result: unknown = CLAIMS;
      if (schema.relevantDocIds) result = { relevantDocIds: zeroSelection ? [] : input.priorArts.map((doc: { docId: number }) => doc.docId), reasoning: "完全架空の固定応答" };
      if (schema.results) {
        if (stopDetail) return Response.json({ usage: null });
        result = { results: input.priorArts.map((doc: { docId: number }) => ({ draftClaimNo: 1, priorDocId: doc.docId,
          lexicalScore: 0.6, elementScore: 0.5, semanticScore: 0.4, structuralScore: 0.3,
          matchedElements: ["完全架空の構成候補"], unmatchedElements: ["架空の条件差"], riskLabel: "Unknown", explanation: EXPLANATION })) };
      }
      return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
        output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 30 } });
    });
    pg = await isolatedPg16(125); seam.db = drizzle(pg.watchClient);
    expect((await isolatedCommand(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/koho-manual-import.tsconfig.json"])).code).toBe(0);
    for (const [packageType, count, issue, date] of [["JPA", 2, "FICTIONAL-FIRST", "2099-03-11"], ["JPB", 2, "FICTIONAL-SECOND", "2099-03-12"], ["JPA", 3, "FICTIONAL-THIRD", "2099-03-13"]] as const) {
      const path = join(pg.directory, `fictional-${files.length}.zip`);
      await writeFile(path, manualFixture(packageType, count, { issue, publicationDate: date })); files.push({ packageType, path });
    }
    from = to = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    await mkdir(out, { recursive: true });
  }, 120_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await pg?.cleanup(); seam.db = undefined; seam.blobs.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }, 60_000);

  it("round-trips TXT, extracts, imports twice, watches, reviews, reports, and preserves failures", async () => {
    const created = await createCase(req("cases", "POST", JSON.stringify({ title: "完全架空・Issue125検証例" })));
    expect(created.status).toBe(201); caseId = (await created.json()).caseId;
    const form = new FormData(); form.set("file", new File([TXT], "fictional.txt", { type: "text/plain" }));
    const uploaded = await upload(new Request("http://127.0.0.1/draft", { method: "POST", body: form }), ctx(caseId));
    expect(uploaded.status).toBe(201); const draft = await uploaded.json(); expect(draft.parsedText).toBe(TXT);
    expect(seam.blobs.get(draft.sourceFilePath)?.toString()).toBe(TXT);
    const extraction = await extract(req("extract", "POST"), { params: Promise.resolve({ caseId: String(caseId), draftId: String(draft.draftId) }) });
    expect(extraction.status).toBe(200); expect(sends).toBe(1);
    const saved = await (await drafts(req("draft"), ctx(caseId))).json(); expect(JSON.parse(saved[0].extractedClaimsJson)).toEqual(CLAIMS);
    expect((await watch.PUT(req("watch", "PUT", JSON.stringify({ enabled: true, monitoringFromDate: "20990301" })), ctx(caseId))).status).toBe(200);
    expect(await apply([0])).toEqual(["inserted"]);
    const result1 = await post(); expect(result1.status).toBe(200); first = await result1.json(); expect(first.newFindingCount).toBe(2);
    const initialCorpus = await corpusSnapshot(), initialCursor = await patentWatchRepo.getSetting(caseId);
    expect(await apply([0, 1])).toEqual(["reused", "inserted"]);
    expect((await corpusSnapshot()).startsWith(initialCorpus.slice(0, -1))).toBe(true);
    expect(await patentWatchRepo.getSetting(caseId)).toEqual(initialCursor);
    const result2 = await post(); expect(result2.status).toBe(200); second = await result2.json(); expect(second.newFindingCount).toBe(2);
    const beforeZero = sends; zero = await (await post()).json(); expect(zero.newFindingCount).toBe(0); expect(sends).toBe(beforeZero);
    const findings = (await (await status()).json()).findings, chosen = findings[0];
    expect((await review.PATCH(req("review", "PATCH", JSON.stringify({ reviewStatus: "reviewed" })), { params: Promise.resolve({ caseId: String(caseId), findingId: String(chosen.findingId) }) })).status).toBe(200);
    expect((await (await status()).json()).findings.find((item: { findingId: number }) => item.findingId === chosen.findingId).reviewStatus).toBe("reviewed");
    expect(sends).toBe(beforeZero);
    const bibliography = renderToStaticMarkup(await BibliographyPage({ params: Promise.resolve({ caseId: String(caseId), findingId: String(chosen.findingId) }) }));
    expect(bibliography).toContain(chosen.publicationNumber); expect(bibliography).toContain("J-PlatPat");
    const csvResponse = await csv.GET(req(`report.csv?runId=${second.runId}`), ctx(caseId)); expect(csvResponse.status).toBe(200);
    const csvText = await csvResponse.text(); expect(csvText).toContain(chosen.publicationNumber); expect(csvText).toContain("reviewed");
    const single = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ caseId: String(caseId), runId: String(second.runId) }) })); expect(single).toContain(chosen.publicationNumber);
    const periodHtml = renderToStaticMarkup(await PeriodPage({ params: Promise.resolve({ caseId: String(caseId) }), searchParams: Promise.resolve({ from, to }) }));
    expect(periodHtml).toContain("新規候補数: 4件"); expect(periodHtml).toContain("確認済み");
    await writeFile(join(out, "report.csv"), csvText); await writeFile(join(out, "period.html"), periodHtml);
    await apply([2]); const beforeFail = await patentWatchRepo.getSetting(caseId); stopDetail = true;
    const stop = await post(); expect(stop.status).toBe(500);
    expect(await stop.json()).toMatchObject({ error: "watch_ai_stopped", diagnosticObservation: { phase: "validating_response" } });
    failed = (await patentWatchRepo.listRuns(caseId, 1))[0]; expect(failed.status).toBe("failed");
    const afterFail = await patentWatchRepo.getSetting(caseId);
    expect(afterFail?.cursorImportId).toBe(beforeFail?.cursorImportId); expect(afterFail?.cursorRunUpdatedAt).toBe(beforeFail?.cursorRunUpdatedAt);
    expect(await patentWatchRepo.listFindings(caseId, { runId: failed.runId, limit: 100 })).toHaveLength(0);
    expect((await csv.GET(req(`report.csv?runId=${failed.runId}`), ctx(caseId))).status).toBe(409);
    const afterSends = sends; await status(); await status(); expect(sends).toBe(afterSends);
    // Independent fictional retry distinguishes a genuine AI zero from a failed run; never rewrites the failed row.
    stopDetail = false; zeroSelection = true;
    const normalZero = await post(); expect(normalZero.status).toBe(200); expect((await normalZero.json()).newFindingCount).toBe(0);
    expect((await patentWatchRepo.getRun(caseId, failed.runId))?.status).toBe("failed");
  }, 90_000);

  it.skipIf(process.env.WATCH_COMPLETION_BROWSER !== "1")("serves only the fictional loopback UI for print acceptance", async () => {
    const require = createRequire(import.meta.url), esbuild = require(require.resolve("esbuild", { paths: [require.resolve("vitest/node")] }));
    const bundle = await esbuild.build({ entryPoints: [resolve("scripts/watch-bibliography-browser.test-support.tsx")], bundle: true, write: false, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
    const postcss = require(require.resolve("postcss", { paths: [require.resolve("@tailwindcss/postcss")] })), tailwind = require("@tailwindcss/postcss");
    const css = (await postcss([tailwind()]).process(await readFile("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") })).css;
    const marker = join(out, "finish-browser"); await unlink(marker).catch(() => undefined);
    server = createServer(async (incoming, res) => {
      try {
        const url = new URL(incoming.url!, "http://127.0.0.1");
        if (incoming.method !== "GET") { res.writeHead(405); res.end(); return; }
        if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
        if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); return; }
        if (url.pathname === `/api/cases/${caseId}/watch`) { const response = await status(); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return; }
        let page, view;
        const finding = new RegExp(`^/cases/${caseId}/watch/findings/(\\d+)$`).exec(url.pathname);
        if (finding) { page = await BibliographyPage({ params: Promise.resolve({ caseId: String(caseId), findingId: finding[1] }) }); view = "bibliography"; }
        else if (url.pathname === `/cases/${caseId}/watch/period-report`) {
          const selected: Record<string, string | string[]> = {};
          for (const key of new Set(url.searchParams.keys())) { const values = url.searchParams.getAll(key); selected[key] = values.length === 1 ? values[0] : values; }
          page = await PeriodPage({ params: Promise.resolve({ caseId: String(caseId) }), searchParams: Promise.resolve(selected) }); view = "period";
        } else { res.writeHead(404); res.end(); return; }
        const props = JSON.stringify({ ...page.props, view }).replaceAll("<", "\\u003c");
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
        res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>完全架空・Issue125</title><link rel="stylesheet" href="/style.css"><body><div id="interactive">${renderToStaticMarkup(page)}</div><script id="fixture-props" type="application/json">${props}</script><script src="/bundle.js"></script></body></html>`);
      } catch { res.writeHead(503); res.end("fictional_test_unavailable"); }
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw Error("loopback_failed");
    await writeFile(join(out, "browser.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}/cases/${caseId}/watch/period-report?from=${from}&to=${to}`, caseId, from, to, sends }));
    console.log("ISSUE125_LOOPBACK_READY");
    for (let n = 0; n < 1800; n++) { if (await access(marker).then(() => true, () => false)) { await unlink(marker); return; } await new Promise(done => setTimeout(done, 1000)); }
    throw Error("loopback_acceptance_timeout");
  }, 1_850_000);

  it("acknowledges case and attachment cleanup without changing the shared corpus", async () => {
    const before = await corpusSnapshot();
    const response = await removeCase(req("case", "DELETE"), ctx(caseId));
    expect(await response.json()).toEqual({ deleted: true, blobCleanup: { attempted: 1, deleted: 1, failed: [], skipped: false } });
    expect((await getCase(req("case"), ctx(caseId))).status).toBe(404);
    expect(await caseRepo.findById(caseId)).toBeNull(); expect(seam.blobs.size).toBe(0);
    expect((await pg!.sql("select count(*)::int n from case_watch_runs"))[0].n).toBe(0);
    expect(await corpusSnapshot()).toBe(before);
  });
});
