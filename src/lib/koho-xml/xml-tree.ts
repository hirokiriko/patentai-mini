import { SaxesParser, type SaxesTagNS } from "saxes";

import type {
  KohoIssueCode,
  KohoXmlElementSnapshot,
  KohoXmlParseInput,
} from "./types";

export interface XmlTreeAttribute {
  namespaceUri: string;
  localName: string;
  sourceName: string;
  value: string;
}

export type XmlTreeChild =
  | { type: "text"; value: string }
  | { type: "element"; element: XmlTreeElement };

export interface XmlTreeElement {
  namespaceUri: string;
  localName: string;
  sourceName: string;
  sourcePath: string;
  attributes: XmlTreeAttribute[];
  children: XmlTreeChild[];
}

interface SourcePathMetadata {
  parent: XmlTreeElement | null;
  segment: string;
  cachedPath: string | null;
}

const sourcePathMetadata = new WeakMap<XmlTreeElement, SourcePathMetadata>();

function materializeSourcePath(element: XmlTreeElement): string {
  const segments: string[] = [];
  let cursor: XmlTreeElement | null = element;
  let prefix = "";

  while (cursor) {
    const metadata = sourcePathMetadata.get(cursor);
    if (!metadata) {
      return cursor.sourcePath;
    }
    if (metadata.cachedPath !== null) {
      prefix = metadata.cachedPath;
      break;
    }
    segments.push(metadata.segment);
    cursor = metadata.parent;
  }

  while (segments.length > 0) {
    prefix += `/${segments.pop()}`;
  }
  const metadata = sourcePathMetadata.get(element);
  if (metadata) {
    metadata.cachedPath = prefix;
  }
  return prefix;
}

export type XmlTreeParseResult =
  | {
      ok: true;
      root: XmlTreeElement;
      xmlByteLength: number;
    }
  | {
      ok: false;
      code: Extract<
        KohoIssueCode,
        | "xml_byte_limit_exceeded"
        | "xml_depth_limit_exceeded"
        | "xml_element_limit_exceeded"
        | "xml_text_limit_exceeded"
        | "doctype_forbidden"
        | "malformed_xml"
        | "invalid_utf8"
        | "unknown_named_entity"
      >;
      xmlByteLength: number | null;
    };

class XmlAbort extends Error {
  constructor(
    readonly code: Extract<
      KohoIssueCode,
      | "xml_depth_limit_exceeded"
      | "xml_element_limit_exceeded"
      | "xml_text_limit_exceeded"
      | "doctype_forbidden"
      | "malformed_xml"
      | "invalid_utf8"
      | "unknown_named_entity"
    >,
  ) {
    super(code);
    this.name = "XmlAbort";
  }
}

export function hasValidLimits(
  limits: KohoXmlParseInput["limits"] | null | undefined,
): boolean {
  if (!limits || typeof limits !== "object") {
    return false;
  }
  return (
    Number.isSafeInteger(limits.maxXmlBytes) &&
    limits.maxXmlBytes > 0 &&
    Number.isSafeInteger(limits.maxDepth) &&
    limits.maxDepth > 0 &&
    Number.isSafeInteger(limits.maxElements) &&
    limits.maxElements > 0 &&
    Number.isSafeInteger(limits.maxTextBytes) &&
    limits.maxTextBytes > 0
  );
}

function utf8ByteLength(value: string): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let addition: number;
    if (codeUnit <= 0x7f) {
      addition = 1;
    } else if (codeUnit <= 0x7ff) {
      addition = 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      addition = 4;
      index += 1;
    } else {
      addition = 3;
    }
    byteLength += addition;
  }
  return byteLength;
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function addWithinLimit(
  used: number,
  addition: number,
  limit: number,
  code: XmlAbort["code"],
): number {
  if (addition > limit - used) {
    throw new XmlAbort(code);
  }
  return used + addition;
}

export function parseXmlTree(
  xml: string | Uint8Array,
  limits: KohoXmlParseInput["limits"],
): XmlTreeParseResult {
  let xmlByteLength: number | null = null;
  let xmlText: string;

  if (typeof xml === "string") {
    if (!hasOnlyUnicodeScalarValues(xml)) {
      return { ok: false, code: "invalid_utf8", xmlByteLength };
    }
    xmlByteLength = utf8ByteLength(xml);
    if (xmlByteLength > limits.maxXmlBytes) {
      return {
        ok: false,
        code: "xml_byte_limit_exceeded",
        xmlByteLength,
      };
    }
    xmlText = xml;
  } else {
    xmlByteLength = xml.byteLength;
    if (xmlByteLength > limits.maxXmlBytes) {
      return { ok: false, code: "xml_byte_limit_exceeded", xmlByteLength };
    }
    try {
      xmlText = new TextDecoder("utf-8", { fatal: true }).decode(xml);
    } catch {
      return { ok: false, code: "invalid_utf8", xmlByteLength };
    }
  }

  const stack: XmlTreeElement[] = [];
  const childNameCounts: Array<Map<string, number>> = [];
  let root: XmlTreeElement | null = null;
  let elementCount = 0;
  let textByteCount = 0;

  try {
    const parser = new SaxesParser({ xmlns: true, fragment: false } as const);

    parser.on("xmldecl", (declaration) => {
      if (
        declaration.encoding &&
        declaration.encoding.toUpperCase() !== "UTF-8"
      ) {
        throw new XmlAbort("invalid_utf8");
      }
    });

    parser.on("doctype", () => {
      throw new XmlAbort("doctype_forbidden");
    });

    parser.on("error", (error) => {
      if (error.message.includes("undefined entity")) {
        throw new XmlAbort("unknown_named_entity");
      }
      throw new XmlAbort("malformed_xml");
    });

    parser.on("opentag", (tag: SaxesTagNS) => {
      const depth = stack.length + 1;
      if (depth > limits.maxDepth) {
        throw new XmlAbort("xml_depth_limit_exceeded");
      }
      elementCount = addWithinLimit(
        elementCount,
        1,
        limits.maxElements,
        "xml_element_limit_exceeded",
      );

      const parent = stack.at(-1);
      const siblingKey = `${tag.uri}\0${tag.local}`;
      const parentCounts = childNameCounts.at(-1);
      const siblingIndex = parentCounts
        ? (parentCounts.get(siblingKey) ?? 0) + 1
        : 1;
      parentCounts?.set(siblingKey, siblingIndex);
      const pathSegment = `${tag.local}[${siblingIndex}]`;
      const element: XmlTreeElement = {
        namespaceUri: tag.uri,
        localName: tag.local,
        sourceName: tag.name,
        get sourcePath() {
          return materializeSourcePath(element);
        },
        attributes: Object.values(tag.attributes).map((attribute) => ({
          namespaceUri: attribute.uri,
          localName: attribute.local,
          sourceName: attribute.name,
          value: attribute.value,
        })),
        children: [],
      };
      sourcePathMetadata.set(element, {
        parent: parent ?? null,
        segment: pathSegment,
        cachedPath: parent ? null : `/${pathSegment}`,
      });

      if (parent) {
        parent.children.push({ type: "element", element });
      } else {
        root = element;
      }
      stack.push(element);
      childNameCounts.push(new Map());
    });

    const appendText = (value: string) => {
      if (value.length === 0) {
        return;
      }
      const byteLength = utf8ByteLength(value);
      textByteCount = addWithinLimit(
        textByteCount,
        byteLength,
        limits.maxTextBytes,
        "xml_text_limit_exceeded",
      );

      const parent = stack.at(-1);
      if (!parent) {
        return;
      }
      const last = parent.children.at(-1);
      if (last?.type === "text") {
        last.value += value;
      } else {
        parent.children.push({ type: "text", value });
      }
    };

    parser.on("text", appendText);
    parser.on("cdata", appendText);
    parser.on("closetag", () => {
      stack.pop();
      childNameCounts.pop();
    });

    parser.write(xmlText).close();

    if (!root || stack.length !== 0) {
      return { ok: false, code: "malformed_xml", xmlByteLength };
    }
    return { ok: true, root, xmlByteLength };
  } catch (error) {
    if (error instanceof XmlAbort) {
      return { ok: false, code: error.code, xmlByteLength };
    }
    return { ok: false, code: "malformed_xml", xmlByteLength };
  }
}

export function isElementNamed(
  element: XmlTreeElement,
  namespaceUri: string,
  localName: string,
): boolean {
  return (
    element.namespaceUri === namespaceUri && element.localName === localName
  );
}

export function childElements(
  element: XmlTreeElement | null | undefined,
): XmlTreeElement[] {
  if (!element) {
    return [];
  }
  return element.children.flatMap((child) =>
    child.type === "element" ? [child.element] : [],
  );
}

export function childrenNamed(
  element: XmlTreeElement | null | undefined,
  namespaceUri: string,
  localName: string,
): XmlTreeElement[] {
  return childElements(element).filter((child) =>
    isElementNamed(child, namespaceUri, localName),
  );
}

export function firstChildNamed(
  element: XmlTreeElement | null | undefined,
  namespaceUri: string,
  localName: string,
): XmlTreeElement | null {
  if (!element) {
    return null;
  }
  return (
    childElements(element).find((child) =>
      isElementNamed(child, namespaceUri, localName),
    ) ?? null
  );
}

export function directPath(
  element: XmlTreeElement | null | undefined,
  path: ReadonlyArray<readonly [namespaceUri: string, localName: string]>,
): XmlTreeElement | null {
  let current = element ?? null;
  for (const [namespaceUri, localName] of path) {
    current = firstChildNamed(current, namespaceUri, localName);
    if (!current) {
      return null;
    }
  }
  return current;
}

export function descendantsNamed(
  element: XmlTreeElement,
  namespaceUri: string,
  localName: string,
): XmlTreeElement[] {
  const matches: XmlTreeElement[] = [];
  const pending = childElements(element).reverse();
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child) {
      break;
    }
    if (isElementNamed(child, namespaceUri, localName)) {
      matches.push(child);
    }
    const children = childElements(child);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return matches;
}

export function attributeValue(
  element: XmlTreeElement | null | undefined,
  namespaceUri: string,
  localName: string,
): string | null {
  return (
    element?.attributes.find(
      (attribute) =>
        attribute.namespaceUri === namespaceUri &&
        attribute.localName === localName,
    )?.value ?? null
  );
}

export function attributeValueByLocalName(
  element: XmlTreeElement | null | undefined,
  localName: string,
): string | null {
  return (
    element?.attributes.find((attribute) => attribute.localName === localName)
      ?.value ?? null
  );
}

export function rawTextContent(element: XmlTreeElement): string {
  const text: string[] = [];
  const pending = [...element.children].reverse();
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child) {
      break;
    }
    if (child.type === "text") {
      text.push(child.value);
      continue;
    }
    for (
      let index = child.element.children.length - 1;
      index >= 0;
      index -= 1
    ) {
      pending.push(child.element.children[index]);
    }
  }
  return text.join("");
}

export function sourceAttributes(
  element: XmlTreeElement,
): Record<string, string> {
  return Object.fromEntries(
    element.attributes.map((attribute) => [
      `{${attribute.namespaceUri}}${attribute.localName}`,
      attribute.value,
    ]),
  );
}

export function toXmlSnapshot(
  element: XmlTreeElement,
): KohoXmlElementSnapshot {
  const createSnapshot = (
    source: XmlTreeElement,
  ): KohoXmlElementSnapshot => ({
    namespaceUri: source.namespaceUri,
    localName: source.localName,
    sourceName: source.sourceName,
    attributes: source.attributes.map((attribute) => ({
      namespaceUri: attribute.namespaceUri,
      localName: attribute.localName,
      sourceName: attribute.sourceName,
      value: attribute.value,
    })),
    children: [],
  });

  const snapshot = createSnapshot(element);
  const pending: Array<{
    source: XmlTreeElement;
    target: KohoXmlElementSnapshot;
  }> = [{ source: element, target: snapshot }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const child of current.source.children) {
      if (child.type === "text") {
        current.target.children.push({ type: "text", value: child.value });
      } else {
        const childSnapshot = createSnapshot(child.element);
        current.target.children.push({
          type: "element",
          element: childSnapshot,
        });
        pending.push({ source: child.element, target: childSnapshot });
      }
    }
  }

  return snapshot;
}
