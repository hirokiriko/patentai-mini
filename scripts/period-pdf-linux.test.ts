import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedPg16, isolatedCommand } from "./watch-report-local.test-support";

// Opt-in: reuse installed Docker, PG16 and the locally built application image.
// No browser, AI, import, production credentials or external account is used.
describe.skipIf(process.env.PERIOD_PDF_LINUX_TEST !== "1")("Linux build/start PDF route with read-only PG16", () => {
  let pg: Awaited<ReturnType<typeof isolatedPg16>> | undefined;
  const owner = randomBytes(8).toString("hex"), container = `period-pdf-test-${owner}`;
  let createAttempted = false, origin = "", before = "";
  const docker = (args: string[], env: Record<string, string | undefined> = {}) => isolatedCommand("docker", ["--config", join(pg!.directory, "docker-config"), ...args], "", env);
  const snapshot = async () => JSON.stringify(await pg!.sql(`select
    (select json_agg(t order by case_id) from cases t) as cases,
    (select json_agg(t order by watch_id) from case_watch_settings t) as settings,
    (select json_agg(t order by run_id) from case_watch_runs t) as runs,
    (select json_agg(t order by finding_id) from case_watch_findings t) as findings`));
  beforeAll(async () => {
    vi.stubEnv("WATCH_REPORT_LOCAL_DB_TEST", "1");
    pg = await isolatedPg16(123);
    await pg.sql("insert into cases(case_id,title) values (1,'完全架空PDF検証'),(2,'完全架空の別案件')");
    await pg.sql("insert into case_watch_settings(watch_id,case_id,monitoring_from_date) values (1,1,'20960301')");
    await pg.sql(`insert into case_watch_runs(run_id,watch_id,status,monitoring_from_date,started_at,completed_at,new_finding_count,analysis_mode)
      values (1,1,'completed','20960301','2096-03-01T00:00:00Z','2096-03-01T01:00:00Z',1,'ai'),
      (2,1,'completed','20960301','2096-03-02T00:00:00Z','2096-03-02T01:00:00Z',0,'none')`);
    await pg.sql(`insert into case_watch_findings(finding_id,watch_id,first_run_id,source_key,package_type,kind,publication_number,publication_date,invention_title,
      lexical_score,element_score,semantic_score,structural_score,risk_label,analysis_json,analysis_mode,review_status,first_seen_at)
      values(1,1,1,$1,'JPA','A','JP2096-000001A','20960229','完全架空の日本語フォント検証',0.5,0.4,0.3,0.2,'Unknown',$2,'ai','reviewed','2096-03-01T01:00:00Z')`,
      ["a".repeat(64), JSON.stringify({ matchedElements: ["完全架空の一致候補"], unmatchedElements: ["完全架空の差分候補"], explanation: "完全架空の日本語の説明末尾。人による原文確認が必要です。" })]);
    before = await snapshot();
    // Only the freshly generated SELECT-only credential enters the local container environment.
    const connection = (pg.reportClient as unknown as { connectionParameters: { user: string; password: string; port: number; database: string } }).connectionParameters;
    const url = new URL("postgresql://host.docker.internal");
    url.username = connection.user; url.password = connection.password; url.port = String(connection.port); url.pathname = connection.database;
    const image = "patentai-issue123-pdf:local";
    expect((await docker(["image", "inspect", image, "--format", "{{.Id}}"])).code).toBe(0);
    createAttempted = true;
    const created = await docker(["create", "--pull", "never", "--name", container, "--label", `patentai.pdf-owner=${owner}`,
      "--publish", "127.0.0.1::3000", "--env", "DATABASE_URL", "--env", "NEXT_TELEMETRY_DISABLED=1", image], { DATABASE_URL: url.toString() });
    expect(created.code === 0).toBe(true);
    expect((await docker(["start", container])).code).toBe(0);
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec((await docker(["port", container, "3000/tcp"])).output);
    if (!match) throw Error("isolated_pdf_port_unavailable");
    origin = `http://127.0.0.1:${match[1]}`;
    let ready = false;
    for (let n = 0; n < 40; n++) {
      try { ready = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000), redirect: "error" })).ok; } catch { /* bounded startup */ }
      if (ready) break;
      await new Promise(done => setTimeout(done, 250));
    }
    expect(ready).toBe(true);
  }, 120_000);
  afterAll(async () => {
    if (createAttempted) {
      const inspected = await docker(["inspect", "--format", '{{index .Config.Labels "patentai.pdf-owner"}}', container]);
      if (inspected.code === 0) {
        if (inspected.output.trim() !== owner) throw Error("isolated_pdf_owner_mismatch");
        expect((await docker(["rm", "--force", "--volumes", container])).code).toBe(0);
      } else if (!/No such (?:object|container)/i.test(inspected.stderr)) throw Error("isolated_pdf_cleanup_unconfirmed");
      const absent = await docker(["inspect", container]);
      expect(absent.code !== 0 && /No such (?:object|container)/i.test(absent.stderr)).toBe(true);
    }
    await pg?.cleanup(); vi.unstubAllEnvs();
  }, 60_000);
  it("downloads a searchable Japanese PDF through actual Next/PG without writes", async () => {
    const path = "/api/cases/1/watch/period-report.pdf?from=2096-03-01&to=2096-03-31";
    const response = await fetch(origin + path, { redirect: "error", signal: AbortSignal.timeout(40_000) });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await response.arrayBuffer()); expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await mkdir(".koho-ops/pdf-qa", { recursive: true }); await writeFile(".koho-ops/pdf-qa/linux-saved.pdf", bytes);
    const page = await fetch(`${origin}/cases/1/watch/period-report?from=2096-03-01&to=2096-03-31`);
    expect(await page.text()).toContain("PDFをダウンロード");
    expect((await fetch(origin + path + "&from=2096-03-01")).status).toBe(400);
    expect((await fetch(origin + path.replace("/cases/1/", "/cases/999/"))).status).toBe(404);
    expect((await fetch(origin + path, { method: "POST" })).status).toBe(405);
    const other = await fetch(origin + path.replace("/cases/1/", "/cases/2/")); expect(other.status).toBe(200);
    await writeFile(".koho-ops/pdf-qa/linux-other-empty.pdf", Buffer.from(await other.arrayBuffer()));
    expect(await snapshot()).toBe(before);
  }, 60_000);
});
