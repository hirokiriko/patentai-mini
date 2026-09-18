import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatentWatchSection, PatentWatchSectionView } from "./watch-section";
import { findingFixture, runFixture, summaryFixture } from "./watch-fixtures.test-support";

// Execute the real component, JSX and click handlers; simulate only hook storage.
const hooks = vi.hoisted(() => ({ active: false, cursor: 0, cells: [] as unknown[], cleanups: [] as Array<() => void> }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = initial;
      return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = value; }];
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useCallback(callback: unknown) { return callback; },
    useEffect(effect: () => void | (() => void)) {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) {
        hooks.cells[index] = true;
        const cleanup = effect();
        if (cleanup) hooks.cleanups.push(cleanup);
      }
    },
  };
});
type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
type Element = ReactElement<Props>;
function render() {
  hooks.cursor = 0; hooks.active = true;
  try { return PatentWatchSectionView(PatentWatchSection({ caseId: 7 }).props); }
  finally { hooks.active = false; }
}
function elements(node: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(node, child => { if (isValidElement<Props>(child)) result.push(child, ...elements(child.props.children)); });
  return result;
}
function button(label: string) {
  return elements(render()).find(node => node.type === "button" && node.props.children === label)!;
}
function click(label: string) {
  const node = button(label);
  expect(node).toBeDefined(); expect(node.props.disabled).toBeFalsy(); node.props.onClick!();
}
function html() { return renderToStaticMarkup(render()); }
async function settle() { await vi.advanceTimersByTimeAsync(1); }
const SECRET = "FICTIONAL_SECRET_DO_NOT_DISPLAY";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "x-fictional-secret": SECRET } });
function transport(post: () => Promise<Response>, getAfter: () => Promise<Response> = async () => response(summaryFixture())) {
  let gets = 0;
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return post();
    if (init?.method === "GET") return ++gets === 1 ? response(summaryFixture()) : getAfter();
    throw new Error(SECRET);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const methods = (mock: ReturnType<typeof transport>) => mock.mock.calls.map(call => call[1]?.method);

describe("watch component events and mock transport", () => {
  beforeEach(() => {
    hooks.cells = []; hooks.cleanups = []; vi.useFakeTimers();
    for (const method of ["error", "warn", "log", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });
  afterEach(() => {
    expect(html()).not.toContain(SECRET);
    for (const method of ["error", "warn", "log", "info"] as const) expect(console[method]).not.toHaveBeenCalled();
    hooks.cleanups.forEach(cleanup => cleanup()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  const diagnostic = { id: "d01e5145-dc6c-4ca3-839b-62bb20b32e84", stage: "detail", reason: "input_limit" };
  const stopped = (value: unknown = diagnostic, header = diagnostic.id) => Response.json(
    { error: "watch_ai_stopped", diagnostic: value, message: SECRET },
    { status: 500, headers: { "X-Patent-Watch-Diagnostic-Id": header } },
  );
  it("shows only this POST's validated diagnostic beside its fixed explanation", async () => {
    const old = summaryFixture(runFixture("completed"));
    const previousId = "22222222-2222-4222-8222-222222222222";
    const mock = transport(async () => stopped(), async () => response({ ...old, diagnostic: { ...diagnostic, id: previousId } }));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain("停止段階：詳細分析");
    expect(html()).toContain("停止分類：入力上限");
    expect(html().split(diagnostic.id)).toHaveLength(2);
    expect(html()).not.toContain(previousId);
    expect(html()).toContain("保存済みの最新実行：監視完了");
    expect(html().slice(html().indexOf("<table"))).not.toContain(diagnostic.id);
    expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
    // A fresh mounted page has no diagnostic; GET cannot restore one.
    hooks.cleanups.forEach(cleanup => cleanup()); hooks.cells = []; hooks.cleanups = [];
    render(); await settle();
    expect(html()).not.toContain(diagnostic.id);
    expect(methods(mock)).toEqual(["GET", "POST", "GET", "GET"]);
  });
  it.each([
    null, [], {}, { ...diagnostic, id: undefined }, { ...diagnostic, stage: undefined },
    { ...diagnostic, reason: undefined }, { ...diagnostic, id: 1 },
    { ...diagnostic, id: "d01e5145-dc6c-1ca3-839b-62bb20b32e84" },
    { ...diagnostic, id: "d01e5145-dc6c-4ca3-139b-62bb20b32e84" },
    { ...diagnostic, id: `<script>${SECRET}</script>` },
    { ...diagnostic, stage: SECRET }, { ...diagnostic, reason: SECRET },
    { ...diagnostic, extra: SECRET },
  ])("discards an invalid diagnostic and keeps the legacy stop explanation %#", async value => {
    const mock = transport(async () => stopped(value));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain("今回の実行：AI保護停止");
    expect(html()).not.toContain("照合用番号");
    expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
  });
  it("ignores a diagnostic with a mismatched response header", async () => {
    transport(async () => stopped(diagnostic, SECRET));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain("今回の実行：AI保護停止");
    expect(html()).not.toContain("照合用番号");
  });
  it.each([
    [1, "ai", 0, "今回の実行：監視完了"], [0, "none", 0, "今回の新着候補は0件"],
    [1, "fallback", 1, "今回の実行：監視完了（fallback"],
  ] as const)("confirms only a valid completed POST: %s/%s", async (count, mode, fallback, expected) => {
    const run = runFixture("completed", { newFindingCount: count, analysisMode: mode, fallbackFindingCount: fallback });
    const saved = summaryFixture(run);
    if (count) saved.findings = [findingFixture()];
    const mock = transport(async () => response(run), async () => response(saved));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain(expected); expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
    if (count) expect(html()).toContain("完全架空の軌道プリズム");
  });
  it.each([
    [409, "watch_not_configured", "先にウォッチ設定"], [409, "watch_disabled", "設定を有効"],
    [409, "watch_claims_not_ready", "抽出済みの請求項"], [409, "watch_run_in_progress", "別の監視実行"],
    [503, "watch_unavailable", "この環境"], [503, "watch_corpus_unavailable", "この環境"],
    [500, "watch_ai_stopped", "今回の実行：AI保護停止"], [500, "watch_internal_error", "今回の実行：サーバーで処理失敗"],
    [500, SECRET, "今回の実行：結果不明"],
  ])("refreshes after HTTP %s/%s with a fixed explanation", async (status, code, expected) => {
    const saved = summaryFixture(runFixture("failed", { errorCode: String(code) }));
    const mock = transport(async () => response({ error: code, message: SECRET, stack: SECRET }, Number(status)), async () => response(saved));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain(expected); expect(html()).toContain("失敗</td>");
    expect(html()).toContain("未確定</td>"); expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
  });
  it.each([200, 500])("handles non-JSON status %s without exposing the body", async status => {
    const mock = transport(async () => new Response(SECRET, { status }));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain("今回の実行：結果不明");
    expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
  });
  it.each(["running", "failed", "completed"] as const)("shows persisted %s after response loss without confirming this attempt", async status => {
    const saved = summaryFixture(runFixture(status));
    saved.findings = [findingFixture()]; saved.unreviewedFindingCount = 4;
    const mock = transport(async () => { throw new Error(SECRET); }, async () => response(saved));
    render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain("今回の実行：結果不明"); expect(html()).not.toContain("今回の実行：監視完了");
    expect(html()).toContain("完全架空の軌道プリズム"); expect(html()).toContain("確認済み");
    click("保存済み情報を再読み込み"); await settle();
    expect(html()).toContain("今回の実行：結果不明");
    expect(button("今すぐ監視").props.disabled).toBe(true);
    button("今すぐ監視").props.onClick!(); await settle();
    expect(methods(mock)).toEqual(["GET", "POST", "GET", "GET"]);
  });
  it("retains an earlier completed snapshot when both POST and GET fail", async () => {
    let gets = 0;
    const saved = summaryFixture(runFixture()); saved.findings = [findingFixture()]; saved.unreviewedFindingCount = 4;
    const mock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET" && ++gets === 1) return response(saved);
      throw new Error(SECRET);
    });
    vi.stubGlobal("fetch", mock); render(); await settle(); click("今すぐ監視"); await settle();
    expect(html()).toContain("今回の実行：結果不明"); expect(html()).not.toContain("今回の実行：監視完了");
    expect(html()).toContain("最新情報は未取得"); expect(html()).toContain("完全架空の軌道プリズム");
    expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
  });
  it("marks initial failed GET as unacquired, never a zero result or synthetic history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: SECRET }, 500)));
    render(); await settle();
    expect(html()).toContain("保存済み履歴は未取得"); expect(html()).not.toContain("正常0件");
    expect(html()).not.toContain("失敗</td>"); expect(button("今すぐ監視").props.disabled).toBe(true);
  });
  it("bounds GET body parsing after headers without inventing saved data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })));
    render(); await settle(); await vi.advanceTimersByTimeAsync(15_000);
    expect(html()).toContain("保存済み履歴は未取得");
    expect(html()).toContain("最新情報は未取得");
    expect(button("保存済み情報を再読み込み").props.disabled).toBe(false);
  });
  it("bounds a hanging refresh and prevents parallel clicks or late POST success", async () => {
    let late!: (value: Response) => void;
    const mock = transport(() => new Promise(resolve => { late = resolve; }), () => new Promise(() => {}));
    render(); await settle(); const node = button("今すぐ監視");
    node.props.onClick!(); node.props.onClick!();
    expect(methods(mock)).toEqual(["GET", "POST"]);
    await vi.advanceTimersByTimeAsync(125_000); await vi.advanceTimersByTimeAsync(15_000);
    expect(html()).toContain("今回の実行：結果不明"); expect(html()).toContain("最新情報は未取得");
    late(response(runFixture())); await settle();
    expect(html()).toContain("今回の実行：結果不明"); expect(methods(mock)).toEqual(["GET", "POST", "GET"]);
  });
});
