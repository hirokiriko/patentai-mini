import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const hooks = vi.hoisted(() => ({ index: 0, state: [] as unknown[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = hooks.index++; hooks.state[index] ??= initial;
  return [hooks.state[index], (value: unknown) => { hooks.state[index] = value; }];
} }));
import { PdfDownloadButton } from "./pdf-download-button";
const render = () => { hooks.index = 0; return PdfDownloadButton({ caseId: 7, period: { from: "2096-03-01", to: "2096-03-31" } }); };
const button = () => (render().props.children[0] as ReactElement<{ onClick(): Promise<void>; disabled: boolean }>).props;
afterEach(() => { hooks.state = []; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("PDF download interaction without a browser runtime", () => {
  it("uses a single GET, displays pending, downloads bytes, then releases its URL", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() }, append = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: append } });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fictional-pdf");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    expect(fetch).not.toHaveBeenCalled(); const pending = button().onClick();
    expect(button().disabled).toBe(true); await button().onClick(); expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response("%PDF-fictional-interaction", { headers: { "content-type": "application/pdf" } })); await pending;
    expect(fetch).toHaveBeenCalledWith("/api/cases/7/watch/period-report.pdf?from=2096-03-01&to=2096-03-31", { cache: "no-store" });
    expect(create).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledWith(link); expect(link.click).toHaveBeenCalledOnce(); expect(link.remove).toHaveBeenCalledOnce();
    expect(link.download).toBe("period-report-7-2096-03-01-2096-03-31.pdf"); expect(button().disabled).toBe(false);
    expect(hooks.state[1]).toContain("ブラウザーの設定"); await vi.advanceTimersByTimeAsync(30_000);
    expect(revoke).toHaveBeenCalledWith("blob:fictional-pdf");
  });
  it.each([413, 422, 503, 200, 0])("shows a fixed failure for %i and never retries or downloads", async status => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    if (!status) fetch.mockRejectedValue(Error("SECRET_SENTINEL"));
    else fetch.mockResolvedValue(new Response("SECRET_SENTINEL", { status, headers: { "content-type": "text/html" } }));
    const create = vi.spyOn(URL, "createObjectURL");
    await button().onClick(); expect(fetch).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false); expect(hooks.state[1]).not.toContain("SECRET_SENTINEL");
    expect(hooks.state[1]).toContain(status === 413 ? "期間を短く" : "期間画面");
  });
});
