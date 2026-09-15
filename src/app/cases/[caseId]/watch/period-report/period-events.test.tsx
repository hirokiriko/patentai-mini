import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeriodSelector } from "./period-selector";
import { PrintButton } from "../runs/[runId]/print-button";
vi.mock("@/lib/patent-watch/period", () => import("../../../../../lib/patent-watch/period"));
const hooks = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => [hooks.state ?? initial, (value: unknown) => { hooks.state = value; }] }));
type Props = { children?: ReactNode; name?: string; type?: string; value?: string; action?: string; method?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
function elements(node: ReactNode): Array<ReactElement<Props>> {
  const result: Array<ReactElement<Props>> = [];
  Children.forEach(node, child => { if (isValidElement<Props>(child)) result.push(child, ...elements(child.props.children)); });
  return result;
}
const render = () => elements(PeriodSelector({ caseId: 7 }));
afterEach(() => { hooks.state = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("real period selector and print component handlers", () => {
  it("edits calendar values without fetch; native GET submit is the only result navigation", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T15:00:00Z"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const button = (label: string) => render().find(node => node.type === "button" && node.props.children === label)!;
    button("前週（月曜〜日曜）").props.onClick!();
    expect(render().find(node => node.props.name === "from")!.props.value).toBe("2026-09-07");
    expect(render().find(node => node.props.name === "to")!.props.value).toBe("2026-09-13");
    button("前月").props.onClick!();
    expect(render().find(node => node.props.name === "from")!.props.value).toBe("2026-08-01");
    render().find(node => node.props.name === "from")!.props.onChange!({ target: { value: "2026-08-03" } });
    expect(render().find(node => node.props.name === "from")!.props.value).toBe("2026-08-03");
    expect(render()[0].props).toMatchObject({ action: "/cases/7/watch/period-report", method: "get" });
    expect(button("期間レポートを表示").props.type).toBe("submit"); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the existing browser print action", () => {
    const print = vi.fn(); vi.stubGlobal("window", { print });
    PrintButton().props.onClick(); expect(print).toHaveBeenCalledTimes(1);
  });
});
