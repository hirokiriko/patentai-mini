import { readFile } from "node:fs/promises";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KohoCorpusPicker } from "../../app/cases/[caseId]/koho-corpus-picker";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const PICKER_SOURCE_URL = new URL(
  "../../app/cases/[caseId]/koho-corpus-picker.tsx",
  import.meta.url,
);
const CASE_PAGE_SOURCE_URL = new URL(
  "../../app/cases/[caseId]/page.tsx",
  import.meta.url,
);

async function readSource(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "koho-corpus-picker.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function collectNamedHandlers(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const handlers = new Map<string, ts.Node>();

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined
    ) {
      handlers.set(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      handlers.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return handlers;
}

function collectJsxHandlers(
  sourceFile: ts.SourceFile,
  attributeName: "onChange" | "onSubmit",
): ts.Node[] {
  const namedHandlers = collectNamedHandlers(sourceFile);
  const handlers: ts.Node[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === attributeName &&
      node.initializer !== undefined &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression !== undefined
    ) {
      const expression = node.initializer.expression;
      if (ts.isIdentifier(expression)) {
        const handler = namedHandlers.get(expression.text);
        if (handler !== undefined) handlers.push(handler);
      } else {
        handlers.push(expression);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return handlers;
}

function containsFetchCall(node: ts.Node): boolean {
  let found = false;

  function visit(child: ts.Node): void {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "fetch"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }

  visit(node);
  return found;
}

function containsIdentifier(node: ts.Node, identifier: string): boolean {
  let found = false;

  function visit(child: ts.Node): void {
    if (ts.isIdentifier(child) && child.text === identifier) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }

  visit(node);
  return found;
}

function collectFetchOwnerNames(sourceFile: ts.SourceFile): string[] {
  const ownerNames: string[] = [];

  function ownerName(node: ts.Node): string | null {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
        return current.name.text;
      }
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        ts.isVariableDeclaration(current.parent) &&
        ts.isIdentifier(current.parent.name)
      ) {
        return current.parent.name.text;
      }
      current = current.parent;
    }
    return null;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    ) {
      const name = ownerName(node);
      ownerNames.push(name ?? "<top-level>");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return ownerNames;
}

function stepFourSource(pageSource: string): string {
  const start = pageSource.indexOf('id="step-4"');
  const end = pageSource.indexOf('id="step-5"', start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return pageSource.slice(start, end);
}

describe("koho corpus picker UI contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not request the corpus during the initial render", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToStaticMarkup(
      createElement(KohoCorpusPicker, { caseId: 7 }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain('id="koho-corpus-query"');
  });

  it("searches only from an explicit submit and never from mount or typing", async () => {
    const sourceFile = parseTsx(await readSource(PICKER_SOURCE_URL));
    const submitHandlers = collectJsxHandlers(sourceFile, "onSubmit");
    const changeHandlers = collectJsxHandlers(sourceFile, "onChange");

    expect(containsIdentifier(sourceFile, "useEffect")).toBe(false);
    expect(submitHandlers.length).toBeGreaterThan(0);
    expect(submitHandlers.some(containsFetchCall)).toBe(true);
    expect(changeHandlers.some(containsFetchCall)).toBe(false);
    expect(collectFetchOwnerNames(sourceFile).sort()).toEqual([
      "handleAttach",
      "handleSearch",
    ]);
  });

  it("is added to Step 4 without replacing the existing import forms", async () => {
    const [pickerSource, pageSource] = await Promise.all([
      readSource(PICKER_SOURCE_URL),
      readSource(CASE_PAGE_SOURCE_URL),
    ]);
    const stepFour = stepFourSource(pageSource);

    expect(pageSource).toMatch(
      /import\s+\{\s*KohoCorpusPicker\s*\}\s+from\s+["']\.\/koho-corpus-picker["']/,
    );
    expect(stepFour).toContain("<KohoCorpusPicker");
    expect(stepFour).toContain("<UploadCsvForm");
    expect(stepFour).toContain("<UploadPatentFilesForm");
    expect(pickerSource).toContain("取り込み済み公報から追加（任意）");
  });

  it("shows stable unavailable and analysis invalidation guidance", async () => {
    const pickerSource = await readSource(PICKER_SOURCE_URL);

    expect(pickerSource).toContain(
      "この環境では公報コーパスがまだ利用可能になっていません",
    );
    expect(pickerSource).toContain(
      "比較対象が変わったため重なり分析を再実行してください",
    );
  });

  it("exposes and enforces the 50-document selection boundary", async () => {
    const pickerSource = await readSource(PICKER_SOURCE_URL);

    expect(pickerSource).toMatch(/type=["']checkbox["']/);
    expect(pickerSource).toMatch(
      /(?:MAX[A-Z_]*(?:SELECT|DOCUMENT)[A-Z_]*|max\w*(?:Select|Document)\w*)\s*=\s*50\b/,
    );
    expect(pickerSource).toMatch(/(?:最大\s*50\s*件|50\s*件まで)/);
  });
});
