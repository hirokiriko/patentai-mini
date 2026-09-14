import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewCaseForm } from "./new-case-form";

// Keep the real component, JSX and event handlers. Only hook storage is
// simulated, so events can be dispatched before React's next render in Node.
const hooks = vi.hoisted(() => ({
  active: false,
  cursor: 0,
  cells: [] as unknown[],
  cleanups: [] as Array<() => void>,
}));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
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
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      if (!hooks.active) return actual.useEffect(effect, deps);
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) {
        hooks.cells[index] = true;
        const cleanup = effect();
        if (cleanup) hooks.cleanups.push(cleanup);
      }
    },
  };
});

type TestEvent = {
  preventDefault: () => void;
  nativeEvent: { isComposing?: boolean };
  key?: string;
  keyCode?: number;
  target: { value: string; checked: boolean };
};
type Props = {
  children?: ReactNode;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  onSubmit?: (event: TestEvent) => void;
  onKeyDown?: (event: TestEvent) => void;
  onChange?: (event: TestEvent) => void;
  onClick?: () => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: (event: TestEvent) => void;
};
type Element = ReactElement<Props>;

function render(): Element {
  hooks.cursor = 0;
  hooks.active = true;
  try {
    return NewCaseForm();
  } finally {
    hooks.active = false;
  }
}

function elements(node: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Props>(child)) return;
    result.push(child, ...elements(child.props.children));
  });
  return result;
}

function inputs(tree: Element) {
  return elements(tree).filter((node) => node.type === "input");
}

function event(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    preventDefault: vi.fn(), nativeEvent: {},
    target: { value: "", checked: false }, ...overrides,
  };
}

function fill() {
  const [title, option] = inputs(render());
  title.props.onChange!(event({ target: { value: "  完全架空テスト案件  ", checked: false } }));
  option.props.onChange!(event({ target: { value: "", checked: true } }));
  inputs(render())[2].props.onChange!(event({ target: { value: "  架空番号001  ", checked: false } }));
  return render();
}

function deferredFetch() {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((done, reject) => {
    resolve = done;
    init.signal!.addEventListener("abort", () => reject(new Error("FICTIONAL_SECRET_ABORT")), { once: true });
  }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, resolve: (response: Response) => resolve(response) };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("new case form submission", () => {
  beforeEach(() => {
    hooks.cells = [];
    hooks.cleanups = [];
    refresh.mockReset();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    hooks.cleanups.forEach((cleanup) => cleanup());
    await settle();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the fictional-material guidance without sending a request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = renderToStaticMarkup(<NewCaseForm />);
    expect(html).toContain("ベース出願・新規事項とも完全架空の資料だけ");
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain('role="alert"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["submit", "title Enter", "number Enter"])("guards all entry points synchronously when starting with %s", async (start) => {
    const request = deferredFetch();
    const tree = fill();
    const [title, , number] = inputs(tree);
    const enter = () => event({ key: "Enter" });
    if (start === "submit") tree.props.onSubmit!(event());
    else (start === "title Enter" ? title : number).props.onKeyDown!(enter());
    // All of these handlers still belong to the same render.
    tree.props.onSubmit!(event());
    title.props.onKeyDown!(enter());
    number.props.onKeyDown!(enter());
    expect(request.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = request.fetchMock.mock.calls[0];
    expect(url).toBe("/api/cases");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      title: "完全架空テスト案件", baseApplicationMode: true, baseApplicationNumber: "架空番号001",
    });
    const pending = render();
    expect(inputs(pending).every((input) => input.props.disabled)).toBe(true);
    const html = renderToStaticMarkup(pending);
    expect(html).toContain("作成中…");
    expect(html).toContain('aria-busy="true"');
    expect(elements(pending).find((node) => node.type === "button" && node.props.type === "submit")!.props.disabled).toBe(true);

    request.resolve(new Response(null, { status: 201 }));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(inputs(render())[0].props.value).toBe("");
    expect(inputs(render())[1].props.checked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(init.signal!.aborted).toBe(false);
    inputs(render())[1].props.onChange!(event({ target: { value: "", checked: true } }));
    expect(inputs(render())[2].props.value).toBe("");
    // Success releases the guard for a later explicit creation.
    fill().props.onSubmit!(event());
    expect(request.fetchMock).toHaveBeenCalledTimes(2);
    request.resolve(new Response(null, { status: 201 }));
    await settle();
  });

  it.each([400, 422, 500, 401, "reject", "timeout"] as const)("retains inputs and releases pending/guard after %s without retry or raw errors", async (failure) => {
    const request = deferredFetch();
    if (failure === "reject") request.fetchMock.mockRejectedValueOnce(new Error("FICTIONAL_SECRET_REJECT"));
    fill().props.onSubmit!(event());
    if (failure === "timeout") {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(request.fetchMock.mock.calls[0][1].signal!.aborted).toBe(false);
      expect(renderToStaticMarkup(render())).toContain("作成中…");
      await vi.advanceTimersByTimeAsync(1);
      expect(request.fetchMock.mock.calls[0][1].signal!.aborted).toBe(true);
    } else if (typeof failure === "number") {
      request.resolve(new Response("FICTIONAL_SECRET_RESPONSE", { status: failure }));
    }
    await settle();
    const failed = render();
    expect(inputs(failed).map((input) => [input.props.value, input.props.checked, input.props.disabled])).toEqual([
      ["  完全架空テスト案件  ", undefined, false], [undefined, true, false], ["  架空番号001  ", undefined, false],
    ]);
    const html = renderToStaticMarkup(failed);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain("FICTIONAL_SECRET");
    expect(refresh).not.toHaveBeenCalled();
    if (failure === 400 || failure === 422) {
      expect(html).toContain("入力内容を確認して、もう一度作成してください。");
      expect(html).not.toContain("案件一覧を更新");
    } else {
      expect(html).toContain("作成結果を確認できませんでした。再作成する前に案件一覧を更新してください。");
      const reload = elements(failed).find((node) => node.type === "button" && node.props.type === "button")!;
      reload.props.onClick!();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(inputs(render())[0].props.value).toBe("  完全架空テスト案件  ");
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request.fetchMock).toHaveBeenCalledTimes(1);
    failed.props.onSubmit!(event());
    expect(request.fetchMock).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(render())).not.toContain('role="alert"');
    request.resolve(new Response(null, { status: 201 }));
    await settle();
  });

  it.each([0, 2])("does not submit IME confirmation in input %s", async (index) => {
    const request = deferredFetch();
    const tree = fill();
    const input = inputs(tree)[index];
    input.props.onCompositionStart!();
    input.props.onKeyDown!(event({ key: "Enter" }));
    tree.props.onSubmit!(event());
    input.props.onCompositionEnd!(event({ target: { value: "架空確定文字", checked: false } }));
    const updatedInput = inputs(render())[index];
    for (const imeEvent of [
      event({ key: "Enter", nativeEvent: { isComposing: true } }),
      event({ key: "Enter", keyCode: 229 }),
    ]) {
      updatedInput.props.onKeyDown!(imeEvent);
      // Model the browser's implicit submit after compositionend. Its submit
      // event has no isComposing/keyCode information of its own.
      if (vi.mocked(imeEvent.preventDefault).mock.calls.length === 0) {
        render().props.onSubmit!(event());
      }
      expect(imeEvent.preventDefault).toHaveBeenCalledOnce();
    }
    render().props.onSubmit!(event({ nativeEvent: { isComposing: true } }));
    updatedInput.props.onKeyDown!(event({ key: "a" }));
    expect(request.fetchMock).not.toHaveBeenCalled();
    updatedInput.props.onKeyDown!(event({ key: "Enter" }));
    expect(request.fetchMock).toHaveBeenCalledTimes(1);
    request.resolve(new Response(null, { status: 201 }));
    await settle();
  });

  it.each(["", " \t　 "])("rejects empty title %j through every entry", (value) => {
    const request = deferredFetch();
    fill();
    inputs(render())[0].props.onChange!(event({ target: { value, checked: false } }));
    const tree = render();
    tree.props.onSubmit!(event());
    inputs(tree)[0].props.onKeyDown!(event({ key: "Enter" }));
    inputs(tree)[2].props.onKeyDown!(event({ key: "Enter" }));
    expect(request.fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the default payload and clears its timer on success", async () => {
    const request = deferredFetch();
    inputs(render())[0].props.onChange!(event({ target: { value: "架空案件", checked: false } }));
    render().props.onSubmit!(event());
    expect(JSON.parse(request.fetchMock.mock.calls[0][1].body as string)).toEqual({
      title: "架空案件", baseApplicationMode: false, baseApplicationNumber: null,
    });
    request.resolve(new Response(null, { status: 201 }));
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request.fetchMock.mock.calls[0][1].signal!.aborted).toBe(false);
    expect(request.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an unmounted form and releases its timer without refreshing", async () => {
    const request = deferredFetch();
    fill().props.onSubmit!(event());
    hooks.cleanups.forEach((cleanup) => cleanup());
    await settle();
    expect(request.fetchMock.mock.calls[0][1].signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(request.fetchMock).toHaveBeenCalledTimes(1);
  });
});
