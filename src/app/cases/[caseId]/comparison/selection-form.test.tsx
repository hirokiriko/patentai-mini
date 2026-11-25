import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { comparisonCatalog } from "@/lib/prior-art-comparison/repository";
import { SelectionForm } from "./selection-form";

// Keep the actual component, effects, timers and GET handling. Only React hook
// storage is simulated, following the existing new-case-form component tests.
const state = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: [] as Array<() => void | (() => void)> }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/prior-art-comparison/limits", () => import("../../../../lib/prior-art-comparison/limits"));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.cells)) state.cells[index] = initial;
    return [state.cells[index], (value: unknown) => { state.cells[index] = value; }];
  },
  useEffect(effect: () => void | (() => void)) { state.effects.push(effect); },
}));

const operationId = "b0000000-0000-4000-8000-000000000007";
const catalog: Awaited<ReturnType<typeof comparisonCatalog>> = {
  caseId: 7, title: "架空の状態表示確認", inputDigest: "a".repeat(64), draft: null, documents: [],
};
let cleanups: Array<() => void>;
let storage: Map<string, string>;
const pendingKey = "prior-art-comparison-pending-7";
function render() {
  state.cursor = 0; state.effects = [];
  return renderToStaticMarkup(SelectionForm({ catalog, completedIds: [], pendingIds: [operationId], blocked: true, enabled: true }));
}
function beginPolling() {
  render(); state.effects[0](); // Recover the actual pending operation.
  render(); const cleanup = state.effects[1]();
  if (cleanup) cleanups.push(cleanup);
}
beforeEach(() => {
  vi.useFakeTimers(); state.cells = []; state.effects = []; cleanups = [];
  refresh.mockReset(); storage = new Map([[pendingKey, operationId]]);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => { for (const cleanup of cleanups) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("does not infer running after an outer callback has rejected but the API still returns reserved", async () => {
  // Fictional status-only reproduction of the retained reserved/callback
  // disagreement. The browser receives no callback lifecycle evidence.
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operationId, status: "reserved" }) });
  vi.stubGlobal("fetch", fetch); beginPolling();
  await vi.advanceTimersByTimeAsync(1000);
  expect(render()).toContain("比較の予約を確認しました。処理中かどうかは不明です");
  expect(render()).toContain("この画面で保存結果を確認しています。AIは再送しません");
  expect(render()).not.toContain("画面を閉じてもサーバー側の処理は続きます");
  expect(storage.get(pendingKey)).toBe(operationId);
  expect(refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const call of fetch.mock.calls) expect(call).toEqual([
    `/api/cases/7/analyze?operationId=${operationId}`, { cache: "no-store" },
  ]);
  expect(sessionStorage.setItem).not.toHaveBeenCalled();
});

it.each([
  ["complete", "比較結果を保存しました。PDF/CSVを取得できます", true],
  ["failed", "品質検証で停止しました。保存予約を保持し、AIは再送しません", false],
  ["unconfirmed", "この操作IDの予約・完了を確認できません。再送せず", false],
] as const)("keeps the existing %s handling and never submits another comparison", async (status, message, complete) => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operationId, status }) });
  vi.stubGlobal("fetch", fetch); beginPolling();
  await vi.advanceTimersByTimeAsync(1000);
  expect(render()).toContain(message);
  expect(refresh).toHaveBeenCalledTimes(complete ? 1 : 0);
  expect(storage.has(pendingKey)).toBe(!complete);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sessionStorage.setItem).not.toHaveBeenCalled();
});
it("a verified new slot ignores but preserves the old sessionStorage operation without manual deletion", () => {
  const assigned = "c0000000-0000-4000-8000-000000000008";
  const props = { catalog, completedIds: [], pendingIds: [operationId], blocked: false, enabled: true,
    admission: { restricted: true, operationId: assigned, canStart: true } };
  state.cursor = 0; state.effects = []; renderToStaticMarkup(SelectionForm(props)); state.effects[0]();
  state.cursor = 0; state.effects = []; const html = renderToStaticMarkup(SelectionForm(props));
  expect(storage.get(pendingKey)).toBe(operationId); expect(sessionStorage.setItem).not.toHaveBeenCalled();
  expect(html).not.toContain(`今回の操作ID: ${operationId}`); expect(html).not.toContain("前回の操作が未照合");
});
