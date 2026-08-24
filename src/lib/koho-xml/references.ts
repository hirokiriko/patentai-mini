import { KOHO_NAMESPACES } from "./constants";
import {
  addKohoReferenceIssues,
  createKohoReference,
} from "./mixed-content";
import type {
  KohoCollectedReference,
  KohoCollectedReferenceKind,
  KohoParseIssue,
} from "./types";
import {
  childElements,
  isElementNamed,
  type XmlTreeElement,
} from "./xml-tree";

interface ReferenceContext {
  inTextFlow: boolean;
  inDrawings: boolean;
  inChosenDrawing: boolean;
  inSearchReport: boolean;
  inReferenceFiles: boolean;
  inForeignLanguageDocument: boolean;
  enclosingMediaKind: KohoCollectedReferenceKind | null;
}

interface PendingElement {
  element: XmlTreeElement;
  context: ReferenceContext;
}

const JP_PATENT = KOHO_NAMESPACES.jpPatent;
const PATENT = KOHO_NAMESPACES.patent;
const COMMON = KOHO_NAMESPACES.common;
const MEDIA_REFERENCE_LOCAL_NAMES: ReadonlySet<string> = new Set([
  "Image",
  "Table",
  "Math",
  "ChemicalFormulae",
]);

function nextContext(
  context: ReferenceContext,
  element: XmlTreeElement,
  mediaKind: ReferenceContext["enclosingMediaKind"],
): ReferenceContext {
  return {
    inTextFlow:
      context.inTextFlow ||
      isElementNamed(element, COMMON, "P") ||
      isElementNamed(element, PATENT, "Claim") ||
      isElementNamed(element, PATENT, "ClaimText") ||
      isElementNamed(element, PATENT, "Abstract") ||
      isElementNamed(element, PATENT, "InventionTitle") ||
      isElementNamed(element, JP_PATENT, "Description"),
    inDrawings:
      context.inDrawings || isElementNamed(element, PATENT, "Drawings"),
    inChosenDrawing:
      context.inChosenDrawing ||
      isElementNamed(element, JP_PATENT, "ChosenDrawingImage"),
    inSearchReport:
      context.inSearchReport ||
      isElementNamed(element, JP_PATENT, "SearchReportBag") ||
      isElementNamed(element, JP_PATENT, "SearchReport"),
    inReferenceFiles:
      context.inReferenceFiles ||
      isElementNamed(element, JP_PATENT, "ReferenceFilesBag") ||
      isElementNamed(element, JP_PATENT, "ReferenceFileBag"),
    inForeignLanguageDocument:
      context.inForeignLanguageDocument ||
      isElementNamed(element, JP_PATENT, "ForeignLanguageDocumentBag"),
    enclosingMediaKind: mediaKind ?? context.enclosingMediaKind,
  };
}

function referenceKind(
  element: XmlTreeElement,
  context: ReferenceContext,
): KohoCollectedReferenceKind | null {
  if (
    context.enclosingMediaKind !== null &&
    ((element.namespaceUri === COMMON &&
      MEDIA_REFERENCE_LOCAL_NAMES.has(element.localName)) ||
      (context.inSearchReport &&
        isElementNamed(element, JP_PATENT, "PageImage")) ||
      (context.inReferenceFiles &&
        isElementNamed(element, JP_PATENT, "ReferenceFile")) ||
      (context.inForeignLanguageDocument &&
        isElementNamed(element, JP_PATENT, "DocumentURI")))
  ) {
    return null;
  }
  if (isElementNamed(element, COMMON, "Table")) {
    return "table_image";
  }
  if (isElementNamed(element, COMMON, "Math")) {
    return "math_image";
  }
  if (isElementNamed(element, COMMON, "ChemicalFormulae")) {
    return "chemical_formula_image";
  }
  if (
    context.inSearchReport &&
    isElementNamed(element, JP_PATENT, "PageImage")
  ) {
    return "search_report_page";
  }
  if (
    context.inReferenceFiles &&
    isElementNamed(element, JP_PATENT, "ReferenceFile")
  ) {
    return "reference_file";
  }
  if (
    context.inForeignLanguageDocument &&
    isElementNamed(element, JP_PATENT, "DocumentURI")
  ) {
    return "foreign_language_document";
  }
  if (!isElementNamed(element, COMMON, "Image")) {
    return null;
  }
  if (context.inDrawings) {
    return "drawing";
  }
  if (context.inChosenDrawing) {
    return "chosen_drawing";
  }
  if (context.inTextFlow) {
    return "inline_image";
  }
  return "other_image";
}

function childMediaKind(
  currentKind: KohoCollectedReferenceKind | null,
  context: ReferenceContext,
): ReferenceContext["enclosingMediaKind"] {
  return currentKind ?? context.enclosingMediaKind;
}

export function collectKohoReferences(
  root: XmlTreeElement,
  sourceEntryPath: string,
  issues: KohoParseIssue[],
): KohoCollectedReference[] {
  const references: KohoCollectedReference[] = [];
  const initialContext: ReferenceContext = {
    inTextFlow: false,
    inDrawings: false,
    inChosenDrawing: false,
    inSearchReport: false,
    inReferenceFiles: false,
    inForeignLanguageDocument: false,
    enclosingMediaKind: null,
  };
  const pending: PendingElement[] = [
    { element: root, context: initialContext },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    const currentKind = referenceKind(current.element, current.context);
    if (currentKind) {
      const reference = createKohoReference(current.element);
      references.push({
        ordinal: references.length + 1,
        kind: currentKind,
        sourceEntryPath,
        reference,
      });
      addKohoReferenceIssues(reference, issues);
      if (currentKind === "other_image") {
        issues.push({
          code: "unknown_inline_element",
          status: "review_required",
          message: "An image in an unmodeled document context was preserved.",
          field: current.element.sourcePath,
        });
      }
    }

    const mediaKind = childMediaKind(currentKind, current.context);
    const context = nextContext(current.context, current.element, mediaKind);
    const children = childElements(current.element);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ element: children[index], context });
    }
  }

  return references;
}
