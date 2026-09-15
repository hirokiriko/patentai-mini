import "../../../globals.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { PatentWatchSection } from "./watch-section";
import { findingFixture, runFixture, summaryFixture } from "./watch-fixtures.test-support";

// Loopback-only visual QA entry. Never imported by an application page.
const scenarios = ["normal", "zero", "fallback", "precondition", "ai-stop", "http500", "non-json", "reject", "saved-completed", "saved-running", "saved-failed", "get-failed"];
const scenario = new URLSearchParams(location.search).get("scenario") ?? "reject";
const SECRET = "FICTIONAL_SECRET_BROWSER_SENTINEL";
let saved = summaryFixture(runFixture());
saved.unreviewedFindingCount = 4;
saved.findings = [findingFixture()];
let gets = 0, posts = 0;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "x-fictional-secret": SECRET } });
window.fetch = async (_input, init) => {
  if (init?.method === "GET") gets++;
  else if (init?.method === "POST") posts++;
  else throw new Error(SECRET);
  document.getElementById("counts")!.textContent = `GET ${gets} / POST ${posts} / 実AI 0 / 実DB 0`;
  if (init?.method === "GET") {
    if (scenario === "get-failed" && gets === 2) throw new Error(SECRET);
    return json(saved);
  }
  const run = runFixture("completed", { runId: 22 });
  if (scenario === "normal" || scenario === "zero" || scenario === "fallback") {
    if (scenario === "zero") run.newFindingCount = 0;
    if (scenario === "fallback") { run.analysisMode = "fallback"; run.fallbackFindingCount = 1; }
    saved = summaryFixture(run);
    if (scenario !== "zero") saved.findings = [findingFixture()];
    return json(run);
  }
  if (scenario === "saved-completed") saved = { ...saved, latestRun: run, runs: [run, ...saved.runs] };
  if (scenario === "saved-running" || scenario === "saved-failed" || scenario === "ai-stop" || scenario === "http500") {
    const status = scenario === "saved-running" ? "running" : "failed";
    const failed = runFixture(status, { runId: 22, errorCode: scenario === "ai-stop" ? "watch_ai_stopped" : "watch_internal_error" });
    saved = { ...saved, latestRun: failed, runs: [failed, ...saved.runs] };
  }
  if (scenario === "precondition") return json({ error: "watch_claims_not_ready", message: SECRET }, 409);
  if (scenario === "ai-stop") return json({ error: "watch_ai_stopped", message: SECRET }, 500);
  if (scenario === "http500") return json({ error: "watch_internal_error", message: SECRET }, 500);
  if (scenario === "non-json") return new Response(SECRET);
  throw new Error(SECRET);
};
const root = document.getElementById("root")!;
createRoot(root).render(<>
  <h1>完全架空データ：手動ウォッチ表示確認</h1>
  <label>検証シナリオ <select value={scenario} onChange={event => { location.search = `?scenario=${event.target.value}`; }}>
    {scenarios.map(value => <option key={value}>{value}</option>)}
  </select></label>
  <p id="counts">GET 0 / POST 0 / 実AI 0 / 実DB 0</p>
  {createElement(PatentWatchSection, { caseId: 7 })}
</>);
