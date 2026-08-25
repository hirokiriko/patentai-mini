import { KOHO_NAMESPACES } from "./constants";
import type {
  KohoContentToken,
  KohoParseIssue,
  KohoReference,
  KohoSourceString,
  KohoStructuredContent,
} from "./types";
import {
  attributeValue,
  childElements,
  rawTextContent,
  sourceAttributes,
  toXmlSnapshot,
  type XmlTreeElement,
} from "./xml-tree";

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function addTextToken(tokens: KohoContentToken[], text: string): void {
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return;
  }
  const last = tokens.at(-1);
  if (last?.type === "text") {
    last.text += normalized;
  } else {
    tokens.push({ type: "text", text: normalized });
  }
}

const mediaReferenceElements = new Set([
  "Image",
  "Table",
  "Math",
  "ChemicalFormulae",
]);
const mediaContainerElements = new Set([
  ...mediaReferenceElements,
  "TableImage",
]);
const mediaMetadataElements = new Set([
  "FileName",
  "DocumentURI",
  "ImageFormatCategory",
  "HeightMeasure",
  "WidthMeasure",
]);

function findMediaElements(
  element: XmlTreeElement,
  localName: string,
): XmlTreeElement[] {
  const matches: XmlTreeElement[] = [];
  const pending = childElements(element).reverse();
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child) {
      break;
    }
    if (
      child.namespaceUri === KOHO_NAMESPACES.common &&
      child.localName === localName
    ) {
      matches.push(child);
    }
    if (
      child.namespaceUri !== KOHO_NAMESPACES.common ||
      !mediaContainerElements.has(child.localName)
    ) {
      continue;
    }
    const children = childElements(child);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return matches;
}

function normalizeReferenceTarget(target: string): string | null {
  if (
    target.includes("\0") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
    /^[\\/]/.test(target) ||
    target.startsWith("\\\\")
  ) {
    return null;
  }
  const normalized = target.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function optionalMetadataSourceString(
  element: XmlTreeElement | null,
): KohoSourceString | null {
  if (!element) {
    return null;
  }
  const sourceValue = rawTextContent(element);
  return {
    sourceValue,
    value: sourceValue.trim().normalize("NFC"),
    ...(childElements(element).length > 0
      ? { sourceElement: toXmlSnapshot(element) }
      : {}),
  };
}

export function createKohoReference(element: XmlTreeElement): KohoReference {
  const fileNameElements = findMediaElements(element, "FileName");
  const imageFormatCategoryElement =
    findMediaElements(element, "ImageFormatCategory")[0] ?? null;
  const heightMeasureElement =
    findMediaElements(element, "HeightMeasure")[0] ?? null;
  const widthMeasureElement =
    findMediaElements(element, "WidthMeasure")[0] ?? null;
  const imageElement =
    element.namespaceUri === KOHO_NAMESPACES.common &&
    element.localName === "Image"
      ? element
      : (findMediaElements(element, "Image")[0] ?? null);
  const attributeTargetElements = [
    element,
    ...findMediaElements(element, "Image"),
    ...findMediaElements(element, "DocumentURI"),
  ];
  const sourceTargets = [
    ...fileNameElements.map(rawTextContent),
    ...attributeTargetElements.flatMap((targetElement) => {
      const target = attributeValue(
        targetElement,
        KOHO_NAMESPACES.common,
        "documentFileName",
      );
      return target === null ? [] : [target];
    }),
  ];
  const scalarElements = [
    ...fileNameElements,
    imageFormatCategoryElement,
    heightMeasureElement,
    widthMeasureElement,
  ].filter((item): item is XmlTreeElement => item !== null);
  const unmodeledScalarPaths = scalarElements
    .filter((item) => childElements(item).length > 0)
    .map((item) => item.sourcePath);
  const targetHasNestedElement = fileNameElements.some(
    (item) => childElements(item).length > 0,
  );
  const sourceTarget = sourceTargets[0] ?? null;
  const normalizedTargets = sourceTargets.map((target) =>
    normalizeReferenceTarget(target.trim().normalize("NFC")),
  );
  const hasSingleSafeTarget =
    sourceTargets.length === 1 &&
    sourceTargets[0].trim().length > 0 &&
    normalizedTargets[0] !== null &&
    !targetHasNestedElement;
  const normalizedTarget = hasSingleSafeTarget ? normalizedTargets[0] : null;
  return {
    sourcePath: element.sourcePath,
    sourceTarget,
    sourceTargets,
    unmodeledScalarPaths,
    normalizedTarget,
    resolution: hasSingleSafeTarget ? "not_inspected" : "rejected",
    preservedText: normalizeText(rawTextContent(element)),
    attributes: sourceAttributes(element),
    metadata: {
      imageFormatCategory: optionalMetadataSourceString(
        imageFormatCategoryElement,
      ),
      heightMeasure: heightMeasureElement
        ? {
            ...optionalMetadataSourceString(heightMeasureElement)!,
            measureUnitCode: attributeValue(
              heightMeasureElement,
              KOHO_NAMESPACES.common,
              "measureUnitCode",
            ),
          }
        : null,
      widthMeasure: widthMeasureElement
        ? {
            ...optionalMetadataSourceString(widthMeasureElement)!,
            measureUnitCode: attributeValue(
              widthMeasureElement,
              KOHO_NAMESPACES.common,
              "measureUnitCode",
            ),
          }
        : null,
      imageContentCategory: attributeValue(
        imageElement ?? element,
        KOHO_NAMESPACES.common,
        "imageContentCategory",
      ),
    },
    source: toXmlSnapshot(element),
  };
}

const referenceIssueKeys = new WeakMap<
  KohoParseIssue[],
  Set<string>
>();

export function addKohoReferenceIssues(
  reference: KohoReference,
  issues: KohoParseIssue[],
): void {
  let issueKeys = referenceIssueKeys.get(issues);
  if (!issueKeys) {
    issueKeys = new Set(
      issues.map((item) => `${item.code}\0${item.field ?? ""}`),
    );
    referenceIssueKeys.set(issues, issueKeys);
  }
  const addReferenceIssue = (item: KohoParseIssue) => {
    const key = `${item.code}\0${item.field ?? ""}`;
    if (issueKeys.has(key)) {
      return;
    }
    issueKeys.add(key);
    issues.push(item);
  };

  if (
    reference.sourceTargets.length === 0 ||
    reference.sourceTargets.some((target) => target.trim().length === 0)
  ) {
    addReferenceIssue({
      code: "required_field_missing",
      status: "review_required",
      message: "An inline media reference has no target filename.",
      field: reference.sourcePath,
    });
  }
  if (reference.sourceTargets.length > 1) {
    addReferenceIssue({
      code: "cardinality_mismatch",
      status: "review_required",
      message: "An inline media reference has multiple target filenames.",
      field: reference.sourcePath,
    });
  }
  const hasUnsafeTarget = reference.sourceTargets.some(
    (target) =>
      target.trim().length > 0 &&
      normalizeReferenceTarget(target.trim().normalize("NFC")) === null,
  );
  if (hasUnsafeTarget) {
    addReferenceIssue({
      code: "unsafe_reference_target",
      status: "review_required",
      message: "An inline media target is not a safe relative reference.",
      field: reference.sourcePath,
    });
  }
  if (reference.unmodeledScalarPaths.length > 0) {
    addReferenceIssue({
      code: "unknown_inline_element",
      status: "review_required",
      message:
        "A media metadata scalar contains nested element content and was preserved for review.",
      field: reference.unmodeledScalarPaths[0],
    });
  }
}

function checkedReferenceFor(
  element: XmlTreeElement,
  issues: KohoParseIssue[],
): KohoReference {
  const reference = createKohoReference(element);
  addKohoReferenceIssues(reference, issues);
  return reference;
}

function referencePlaceholder(
  kind: "image" | "table" | "math" | "chemical-formula",
  reference: KohoReference,
): string {
  const target =
    reference.normalizedTarget ??
    (reference.sourceTarget?.trim().length
      ? reference.sourceTarget
      : "unknown");
  return `[${kind}:${target}]`;
}

export function plainTextFromTokens(tokens: KohoContentToken[]): string {
  const pieces: string[] = [];
  const pending: Array<KohoContentToken | string> = [];
  const pushTokens = (nestedTokens: KohoContentToken[]) => {
    for (let index = nestedTokens.length - 1; index >= 0; index -= 1) {
      pending.push(nestedTokens[index]);
    }
  };
  pushTokens(tokens);

  while (pending.length > 0) {
    const token = pending.pop();
    if (token === undefined) {
      break;
    }
    if (typeof token === "string") {
      pieces.push(token);
      continue;
    }
    switch (token.type) {
      case "text":
        pieces.push(token.text);
        break;
      case "boundary":
        pieces.push("\n");
        break;
      case "figure_reference":
        pieces.push(token.text || "[figure:unknown]");
        break;
      case "patent_citation":
        pieces.push(token.plainText);
        break;
      case "image_reference":
        pieces.push(referencePlaceholder("image", token.reference));
        break;
      case "table_reference":
        pieces.push(referencePlaceholder("table", token.reference));
        break;
      case "math_reference":
        pieces.push(referencePlaceholder("math", token.reference));
        break;
      case "chemical_formula_reference":
        pieces.push(
          referencePlaceholder("chemical-formula", token.reference),
        );
        break;
      case "subscript":
      case "superscript":
        if (token.plainText !== null) {
          pieces.push(
            `${token.type === "subscript" ? "_" : "^"}{${token.plainText}}`,
          );
        } else {
          pending.push("}");
          pushTokens(token.content);
          pending.push(token.type === "subscript" ? "_{" : "^{");
        }
        break;
      case "unknown_inline_element":
        if (token.plainText !== null) {
          pieces.push(token.plainText);
        } else {
          pushTokens(token.content);
        }
        break;
    }
  }

  return pieces.join("").normalize("NFC");
}

const transparentCommonElements = new Set([
  "B",
  "I",
  "U",
  "Sub",
  "Sup",
  "P",
]);

const transparentPatentElements = new Set([
  "ClaimText",
  "PatentCitation",
]);
const patentCitationDescendantQNames: ReadonlySet<string> = new Set([
  `${KOHO_NAMESPACES.patent}\0PatentCitationText`,
  `${KOHO_NAMESPACES.patent}\0PatentDocumentIdentification`,
  `${KOHO_NAMESPACES.patent}\0PublicationContact`,
  `${KOHO_NAMESPACES.patent}\0PublicationNumber`,
  `${KOHO_NAMESPACES.patent}\0PatentDocumentKindCode`,
  `${KOHO_NAMESPACES.patent}\0ApplicationNumber`,
  `${KOHO_NAMESPACES.patent}\0FilingDate`,
  `${KOHO_NAMESPACES.common}\0IPOfficeCode`,
  `${KOHO_NAMESPACES.common}\0CountryCode`,
  `${KOHO_NAMESPACES.common}\0PublicationDate`,
  `${KOHO_NAMESPACES.common}\0ApplicationNumber`,
  `${KOHO_NAMESPACES.common}\0ApplicationNumberText`,
]);
const noKnownDescendantQNames: ReadonlySet<string> = new Set();

function isTransparent(element: XmlTreeElement): boolean {
  return (
    (element.namespaceUri === KOHO_NAMESPACES.common &&
      transparentCommonElements.has(element.localName)) ||
    (element.namespaceUri === KOHO_NAMESPACES.patent &&
      transparentPatentElements.has(element.localName))
  );
}

type WalkOperation =
  | {
      type: "text";
      value: string;
      tokens: KohoContentToken[];
    }
  | {
      type: "element" | "unknown_element";
      element: XmlTreeElement;
      tokens: KohoContentToken[];
      withinMedia: boolean;
      withinUnknown: boolean;
      withinStructuredToken: boolean;
    }
  | {
      type: "media_children";
      element: XmlTreeElement;
      tokens: KohoContentToken[];
      withinUnknown: boolean;
      withinStructuredToken: boolean;
    }
  | {
      type: "boundary";
      boundary: "line_break" | "paragraph" | "claim";
      tokens: KohoContentToken[];
    }
  | {
      type: "finish_script";
      script: "Sub" | "Sup";
      nestedTokens: KohoContentToken[];
      tokens: KohoContentToken[];
      materializePlainText: boolean;
    }
  | {
      type: "finish_unknown";
      element: XmlTreeElement;
      nestedTokens: KohoContentToken[];
      tokens: KohoContentToken[];
      reportIssue: boolean;
      materializePlainText: boolean;
    }
  | {
      type: "review_media_text";
      field: string;
    };

function pushChildOperations(
  stack: WalkOperation[],
  element: XmlTreeElement,
  tokens: KohoContentToken[],
  withinMedia = false,
  withinUnknown = false,
  withinStructuredToken = false,
): void {
  const hasDirectParagraph = element.children.some(
    (child) =>
      child.type === "element" &&
      child.element.namespaceUri === KOHO_NAMESPACES.common &&
      child.element.localName === "P",
  );
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index];
    if (
      hasDirectParagraph &&
      child.type === "text" &&
      child.value.trim().length === 0
    ) {
      continue;
    }
    stack.push(
      child.type === "text"
        ? { type: "text", value: child.value, tokens }
        : {
            type: "element",
            element: child.element,
            tokens,
            withinMedia,
            withinUnknown,
            withinStructuredToken,
          },
    );
  }
}

function scheduleUnknownElement(
  stack: WalkOperation[],
  element: XmlTreeElement,
  tokens: KohoContentToken[],
  withinMedia: boolean,
  withinUnknown: boolean,
  withinStructuredToken: boolean,
): void {
  const nestedTokens: KohoContentToken[] = [];
  stack.push({
    type: "finish_unknown",
    element,
    nestedTokens,
    tokens,
    reportIssue: !withinUnknown,
    materializePlainText: !withinStructuredToken,
  });
  pushChildOperations(stack, element, nestedTokens, withinMedia, true, true);
}

function scheduleMediaChildren(
  stack: WalkOperation[],
  element: XmlTreeElement,
  tokens: KohoContentToken[],
  withinUnknown: boolean,
  withinStructuredToken: boolean,
): void {
  const parentIsMetadata =
    element.namespaceUri === KOHO_NAMESPACES.common &&
    mediaMetadataElements.has(element.localName);
  const hasUnmodeledDirectText =
    !parentIsMetadata &&
    element.children.some(
      (child) => child.type === "text" && child.value.trim().length > 0,
    );
  if (hasUnmodeledDirectText && !withinUnknown) {
    stack.push({ type: "review_media_text", field: element.sourcePath });
  }

  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index];
    if (child.type === "text") {
      if (!parentIsMetadata && child.value.trim().length > 0) {
        stack.push({ type: "text", value: child.value, tokens });
      }
      continue;
    }

    const nested = child.element;
    stack.push(
      nested.namespaceUri === KOHO_NAMESPACES.common &&
        (mediaContainerElements.has(nested.localName) ||
          mediaMetadataElements.has(nested.localName))
        ? {
            type: "media_children",
            element: nested,
            tokens,
            withinUnknown,
            withinStructuredToken,
          }
        : {
            type: "unknown_element",
            element: nested,
            tokens,
            withinMedia: true,
            withinUnknown,
            withinStructuredToken,
          },
    );
  }
}

function reviewUnexpectedDescendants(
  element: XmlTreeElement,
  issues: KohoParseIssue[],
  knownQNames: ReadonlySet<string>,
): void {
  const pending = childElements(element);
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child) {
      break;
    }
    if (!knownQNames.has(`${child.namespaceUri}\0${child.localName}`)) {
      issues.push({
        code: "unknown_inline_element",
        status: "review_required",
        message:
          "An unrecognized inline XML element was preserved for review.",
        field: child.sourcePath,
      });
      return;
    }
    for (const nested of childElements(child)) {
      pending.push(nested);
    }
  }
}

function scheduleElement(
  stack: WalkOperation[],
  element: XmlTreeElement,
  tokens: KohoContentToken[],
  issues: KohoParseIssue[],
  withinMedia: boolean,
  withinUnknown: boolean,
  withinStructuredToken: boolean,
): void {
  if (
    withinMedia &&
    element.namespaceUri === KOHO_NAMESPACES.common &&
    (mediaContainerElements.has(element.localName) ||
      mediaMetadataElements.has(element.localName))
  ) {
    stack.push({
      type: "media_children",
      element,
      tokens,
      withinUnknown,
      withinStructuredToken,
    });
    return;
  }

  if (
    element.namespaceUri === KOHO_NAMESPACES.common &&
    element.localName === "Br"
  ) {
    if (element.children.length === 0) {
      tokens.push({ type: "boundary", boundary: "line_break" });
      return;
    }
    stack.push({ type: "boundary", boundary: "line_break", tokens });
    if (
      !withinUnknown &&
      element.children.some(
        (child) => child.type === "text" && child.value.trim().length > 0,
      )
    ) {
      stack.push({ type: "review_media_text", field: element.sourcePath });
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index];
      if (child.type === "text") {
        if (child.value.trim().length > 0) {
          stack.push({ type: "text", value: child.value, tokens });
        }
      } else {
        stack.push({
          type: "unknown_element",
          element: child.element,
          tokens,
          withinMedia,
          withinUnknown,
          withinStructuredToken,
        });
      }
    }
    return;
  }

  if (
    (element.namespaceUri === KOHO_NAMESPACES.common ||
      element.namespaceUri === KOHO_NAMESPACES.patent) &&
    element.localName === "FigureReference"
  ) {
    const text = normalizeText(rawTextContent(element));
    const referencedFigureNumber = attributeValue(
      element,
      KOHO_NAMESPACES.common,
      "referencedFigureNumber",
    );
    tokens.push({
      type: "figure_reference",
      reference: {
        sourcePath: element.sourcePath,
        sourceTarget: referencedFigureNumber,
        sourceTargets:
          referencedFigureNumber === null ? [] : [referencedFigureNumber],
        unmodeledScalarPaths: [],
        normalizedTarget: referencedFigureNumber,
        resolution: "not_inspected",
        preservedText: text,
        attributes: sourceAttributes(element),
        metadata: {
          imageFormatCategory: null,
          heightMeasure: null,
          widthMeasure: null,
          imageContentCategory: null,
        },
        source: toXmlSnapshot(element),
      },
      text,
    });
    reviewUnexpectedDescendants(element, issues, noKnownDescendantQNames);
    return;
  }

  if (
    element.namespaceUri === KOHO_NAMESPACES.patent &&
    element.localName === "PatentCitation"
  ) {
    const plainText = normalizeText(rawTextContent(element));
    const content: KohoContentToken[] = plainText
      ? [{ type: "text", text: plainText }]
      : [];
    tokens.push({
      type: "patent_citation",
      namespaceUri: element.namespaceUri,
      content,
      plainText,
      attributes: sourceAttributes(element),
      source: toXmlSnapshot(element),
    });
    reviewUnexpectedDescendants(
      element,
      issues,
      patentCitationDescendantQNames,
    );
    return;
  }

  if (
    element.namespaceUri === KOHO_NAMESPACES.common &&
    element.localName === "Image"
  ) {
    tokens.push({
      type: "image_reference",
      reference: checkedReferenceFor(element, issues),
    });
    stack.push({
      type: "media_children",
      element,
      tokens,
      withinUnknown,
      withinStructuredToken,
    });
    return;
  }

  if (
    element.namespaceUri === KOHO_NAMESPACES.common &&
    element.localName === "Table"
  ) {
    const reference = checkedReferenceFor(element, issues);
    tokens.push({
      type: "table_reference",
      reference,
    });
    stack.push({
      type: "media_children",
      element,
      tokens,
      withinUnknown,
      withinStructuredToken,
    });
    return;
  }

  if (
    element.namespaceUri === KOHO_NAMESPACES.common &&
    element.localName === "Math"
  ) {
    const reference = checkedReferenceFor(element, issues);
    tokens.push({
      type: "math_reference",
      reference,
    });
    stack.push({
      type: "media_children",
      element,
      tokens,
      withinUnknown,
      withinStructuredToken,
    });
    return;
  }

  if (
    element.namespaceUri === KOHO_NAMESPACES.common &&
    element.localName === "ChemicalFormulae"
  ) {
    const reference = checkedReferenceFor(element, issues);
    tokens.push({
      type: "chemical_formula_reference",
      reference,
    });
    stack.push({
      type: "media_children",
      element,
      tokens,
      withinUnknown,
      withinStructuredToken,
    });
    return;
  }

  if (isTransparent(element)) {
    if (
      element.namespaceUri === KOHO_NAMESPACES.common &&
      element.localName === "P"
    ) {
      stack.push({ type: "boundary", boundary: "paragraph", tokens });
      pushChildOperations(
        stack,
        element,
        tokens,
        withinMedia,
        withinUnknown,
        withinStructuredToken,
      );
      return;
    }
    if (
      element.namespaceUri === KOHO_NAMESPACES.common &&
      (element.localName === "Sub" || element.localName === "Sup")
    ) {
      const nestedTokens: KohoContentToken[] = [];
      stack.push({
        type: "finish_script",
        script: element.localName,
        nestedTokens,
        tokens,
        materializePlainText: !withinStructuredToken,
      });
      pushChildOperations(
        stack,
        element,
        nestedTokens,
        withinMedia,
        withinUnknown,
        true,
      );
      return;
    }
    pushChildOperations(
      stack,
      element,
      tokens,
      withinMedia,
      withinUnknown,
      withinStructuredToken,
    );
    return;
  }

  scheduleUnknownElement(
    stack,
    element,
    tokens,
    withinMedia,
    withinUnknown,
    withinStructuredToken,
  );
}

function walkChildren(
  element: XmlTreeElement,
  tokens: KohoContentToken[],
  issues: KohoParseIssue[],
): void {
  const stack: WalkOperation[] = [];
  pushChildOperations(stack, element, tokens);

  while (stack.length > 0) {
    const operation = stack.pop();
    if (!operation) {
      break;
    }
    switch (operation.type) {
      case "text":
        addTextToken(operation.tokens, operation.value);
        break;
      case "boundary":
        operation.tokens.push({
          type: "boundary",
          boundary: operation.boundary,
        });
        break;
      case "element":
        scheduleElement(
          stack,
          operation.element,
          operation.tokens,
          issues,
          operation.withinMedia,
          operation.withinUnknown,
          operation.withinStructuredToken,
        );
        break;
      case "unknown_element":
        scheduleUnknownElement(
          stack,
          operation.element,
          operation.tokens,
          operation.withinMedia,
          operation.withinUnknown,
          operation.withinStructuredToken,
        );
        break;
      case "media_children":
        scheduleMediaChildren(
          stack,
          operation.element,
          operation.tokens,
          operation.withinUnknown,
          operation.withinStructuredToken,
        );
        break;
      case "finish_script": {
        const nestedText = operation.materializePlainText
          ? plainTextFromTokens(operation.nestedTokens)
          : null;
        operation.tokens.push({
          type: operation.script === "Sub" ? "subscript" : "superscript",
          content: operation.nestedTokens,
          plainText: nestedText,
        });
        break;
      }
      case "finish_unknown": {
        const plainText = operation.materializePlainText
          ? plainTextFromTokens(operation.nestedTokens)
          : null;
        operation.tokens.push({
          type: "unknown_inline_element",
          namespaceUri: operation.element.namespaceUri,
          localName: operation.element.localName,
          content: operation.nestedTokens,
          plainText,
        });
        if (operation.reportIssue) {
          issues.push({
            code: "unknown_inline_element",
            status: "review_required",
            message:
              "An unrecognized inline XML element subtree was preserved for review.",
            field: operation.element.sourcePath,
          });
        }
        break;
      }
      case "review_media_text":
        issues.push({
          code: "unknown_inline_element",
          status: "review_required",
          message: "Unmodeled inline media text was preserved for review.",
          field: operation.field,
        });
        break;
    }
  }
}

function trimOuterTextTokens(tokens: KohoContentToken[]): void {
  const first = tokens[0];
  if (first?.type === "text") {
    first.text = first.text.replace(/^\s+/, "");
    if (first.text.length === 0) {
      tokens.shift();
    }
  }

  const last = tokens.at(-1);
  if (last?.type === "text") {
    last.text = last.text.replace(/\s+$/, "");
    if (last.text.length === 0) {
      tokens.pop();
    }
  }
}

export function renderStructuredContent(
  element: XmlTreeElement,
  issues: KohoParseIssue[],
  terminalBoundary?: "paragraph" | "claim",
): KohoStructuredContent {
  const tokens: KohoContentToken[] = [];
  walkChildren(element, tokens, issues);
  trimOuterTextTokens(tokens);
  if (terminalBoundary) {
    tokens.push({ type: "boundary", boundary: terminalBoundary });
  }
  const plainText = plainTextFromTokens(tokens).replace(/\n$/, "");
  return { tokens, plainText };
}
