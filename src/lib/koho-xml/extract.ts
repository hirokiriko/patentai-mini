import { KOHO_NAMESPACES, type KohoRootDefinition } from "./constants";
import {
  renderStructuredContent,
} from "./mixed-content";
import { collectKohoReferences } from "./references";
import type {
  KohoAmendmentDocument,
  KohoApplicant,
  KohoApplicantName,
  KohoClassification,
  KohoClaim,
  KohoDateValue,
  KohoDescriptionParagraph,
  KohoFullPublicationDocument,
  KohoParseIssue,
  KohoSourceString,
  KohoStructuredContent,
  KohoXmlSourceMetadata,
} from "./types";
import {
  attributeValue,
  childElements,
  childrenNamed,
  firstChildNamed,
  isElementNamed,
  rawTextContent,
  sourceAttributes,
  toXmlSnapshot,
  type XmlTreeElement,
} from "./xml-tree";

type FullPublicationKind = KohoFullPublicationDocument["kind"];
type AmendmentKind = KohoAmendmentDocument["kind"];

const JP_PATENT = KOHO_NAMESPACES.jpPatent;
const JP_COMMON = KOHO_NAMESPACES.jpCommon;
const PATENT = KOHO_NAMESPACES.patent;
const COMMON = KOHO_NAMESPACES.common;
const knownDescriptionContainerLocalNames: ReadonlySet<string> = new Set([
  "TechnicalField",
  "BackgroundArt",
  "CitationList",
  "SummaryOfInvention",
  "TechnicalProblem",
  "SolutionToProblem",
  "AdvantageousEffectsOfInvention",
  "BriefDescriptionOfDrawings",
  "DescriptionOfEmbodiments",
  "IndustrialApplicability",
  "ReferenceSignsList",
  "DisclosureOfInvention",
  "BestMode",
]);

function normalizedValue(sourceValue: string): string {
  return sourceValue.trim().normalize("NFC");
}

function sourceString(
  element: XmlTreeElement,
  issues?: KohoParseIssue[],
  field?: string,
): KohoSourceString {
  const sourceValue = rawTextContent(element);
  const hasElementContent = childElements(element).length > 0;
  if (hasElementContent && issues) {
    addIssue(issues, {
      code: "unknown_inline_element",
      status: "review_required",
      message:
        "A scalar XML field contains nested element content and was preserved for review.",
      field: field ?? element.sourcePath,
    });
  }
  return {
    sourceValue,
    value: normalizedValue(sourceValue),
    ...(hasElementContent ? { sourceElement: toXmlSnapshot(element) } : {}),
  };
}

function addIssue(issues: KohoParseIssue[], issue: KohoParseIssue): void {
  issues.push(issue);
}

function singletonChildNamed(
  element: XmlTreeElement | null | undefined,
  namespaceUri: string,
  localName: string,
  issues: KohoParseIssue[],
  field: string,
): XmlTreeElement | null {
  const matches = childrenNamed(element, namespaceUri, localName);
  if (matches.length > 1) {
    addIssue(issues, {
      code: "cardinality_mismatch",
      status: "review_required",
      message: "A singleton XML field occurs more than once.",
      field,
    });
  }
  return matches[0] ?? null;
}

function singletonDirectPath(
  element: XmlTreeElement | null | undefined,
  path: ReadonlyArray<readonly [namespaceUri: string, localName: string]>,
  issues: KohoParseIssue[],
  field: string,
): XmlTreeElement | null {
  let current = element ?? null;
  for (const [namespaceUri, localName] of path) {
    current = singletonChildNamed(
      current,
      namespaceUri,
      localName,
      issues,
      field,
    );
    if (!current) {
      return null;
    }
  }
  return current;
}

function requiredSourceString(
  element: XmlTreeElement | null,
  issues: KohoParseIssue[],
  field: string,
): KohoSourceString | null {
  if (!element) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "A required XML field is missing.",
      field,
    });
    return null;
  }

  const value = sourceString(element, issues, field);
  if (value.value.length === 0) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "A required XML field is empty.",
      field: element.sourcePath,
    });
    return null;
  }
  return value;
}

function optionalSourceString(
  element: XmlTreeElement | null,
  issues: KohoParseIssue[],
  field: string,
): KohoSourceString | null {
  return element ? sourceString(element, issues, field) : null;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function dateValue(
  element: XmlTreeElement | null,
  issues: KohoParseIssue[],
  field: string,
  required: boolean,
): KohoDateValue | null {
  if (!element) {
    if (required) {
      addIssue(issues, {
        code: "required_field_missing",
        status: "failed",
        message: "A required date field is missing.",
        field,
      });
    }
    return null;
  }

  const value = sourceString(element, issues, field);
  if (!isValidIsoDate(value.value)) {
    addIssue(issues, {
      code: "invalid_date",
      status: "failed",
      message: "An XML date does not use a valid YYYY-MM-DD value.",
      field: element.sourcePath,
    });
    return null;
  }
  return value;
}

function hasFailedIssue(issues: KohoParseIssue[]): boolean {
  return issues.some((issue) => issue.status === "failed");
}

function classifications(
  container: XmlTreeElement | null,
  mode: "ipc" | "fi",
  issues: KohoParseIssue[],
): KohoClassification[] {
  if (!container) {
    return [];
  }

  const mainNamespace = mode === "ipc" ? PATENT : JP_PATENT;
  const mainLocalName =
    mode === "ipc" ? "MainClassification" : "MainNationalClassification";
  const furtherLocalName =
    mode === "ipc"
      ? "FurtherClassification"
      : "FurtherNationalClassification";
  const containerAttributes = Object.freeze(sourceAttributes(container));

  const directClassifications = childElements(container);
  const mainClassifications = directClassifications.filter((classification) =>
    isElementNamed(classification, mainNamespace, mainLocalName),
  );
  if (
    (mode === "ipc" && mainClassifications.length > 1) ||
    (mode === "fi" && mainClassifications.length !== 1)
  ) {
    addIssue(issues, {
      code: "cardinality_mismatch",
      status: "review_required",
      message:
        mode === "ipc"
          ? "The IPC container has multiple main classifications."
          : "The FI container must have exactly one main classification.",
      field: container.sourcePath,
    });
  }

  return directClassifications.flatMap((classification) => {
    let role: KohoClassification["role"];
    if (
      isElementNamed(classification, mainNamespace, mainLocalName)
    ) {
      role = "main";
    } else if (
      isElementNamed(classification, mainNamespace, furtherLocalName)
    ) {
      role = "further";
    } else {
      return [];
    }

    let valueElements: XmlTreeElement[] = [classification];
    if (mode === "fi") {
      valueElements = childrenNamed(
        classification,
        PATENT,
        "PatentClassificationText",
      );
      if (valueElements.length !== 1) {
        addIssue(issues, {
          code: "cardinality_mismatch",
          status: "review_required",
          message:
            "An FI classification must contain exactly one classification text value.",
          field: classification.sourcePath,
        });
      }
    }
    const sources = valueElements.map((element) =>
      sourceString(element, issues, classification.sourcePath),
    );
    const sourceValues = sources.map((item) => item.sourceValue);
    const values = sources.map((item) => item.value);
    const sourceValue = sourceValues[0] ?? "";
    const valueElement = valueElements[0] ?? null;
    const attributes: KohoClassification["attributes"] = {
      container: containerAttributes,
      classification: sourceAttributes(classification),
      value:
        valueElement && valueElement !== classification
          ? sourceAttributes(valueElement)
          : {},
    };
    return [
      {
        ordinal: 0,
        role,
        sourceValue,
        sourceValues,
        value: values[0] ?? "",
        values,
        sources,
        attributes,
      },
    ];
  }).map((classification, index) => ({
    ...classification,
    ordinal: index + 1,
  }));
}

function originalLanguageIndicator(contact: XmlTreeElement): boolean | null {
  const attributeIndicator = attributeValue(
    contact,
    JP_COMMON,
    "OriginalLanguageIndicator",
  );
  const childIndicator = firstChildNamed(
    contact,
    JP_COMMON,
    "OriginalLanguageIndicator",
  );
  const sourceValue =
    attributeIndicator ??
    (childIndicator ? rawTextContent(childIndicator) : null);
  if (sourceValue === null) {
    return null;
  }
  const value = normalizedValue(sourceValue).toLowerCase();
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return null;
}

function applicantNames(
  contact: XmlTreeElement,
  issues: KohoParseIssue[],
): KohoApplicantName[] {
  const indicator = originalLanguageIndicator(contact);
  return childrenNamed(contact, COMMON, "Name").flatMap((nameContainer) =>
    childrenNamed(nameContainer, COMMON, "EntityName").map((name) => ({
      ...sourceString(name, issues, name.sourcePath),
      originalLanguageIndicator: indicator,
    })),
  );
}

function extractApplicants(
  bibliographicData: XmlTreeElement | null,
  partyBagLocalName: string | undefined,
  issues: KohoParseIssue[],
): KohoApplicant[] {
  const partyBag = partyBagLocalName
    ? singletonChildNamed(
        bibliographicData,
        JP_PATENT,
        partyBagLocalName,
        issues,
        "partyBag",
      )
    : null;
  const applicantsBag = singletonDirectPath(
    partyBag,
    [[JP_PATENT, "ApplicantsRegisteredPractitionersBag"]],
    issues,
    "applicants",
  );
  const applicants = applicantsBag
    ? childrenNamed(
        applicantsBag,
        JP_PATENT,
        "ApplicantRegisteredPractitionerBag",
      ).flatMap((applicantBag) =>
        childrenNamed(applicantBag, JP_PATENT, "Applicant"),
      )
    : [];

  const incompleteApplicantOrdinals = new Set<number>();
  const extracted = applicants.map((applicant, index): KohoApplicant => {
    const contacts = childrenNamed(applicant, JP_COMMON, "Contact");
    const names = contacts.flatMap((contact) =>
      applicantNames(contact, issues),
    );
    const hasIncompleteName =
      contacts.length === 0 ||
      contacts.some((contact) => {
        const nameContainers = childrenNamed(contact, COMMON, "Name");
        const entityNames = nameContainers.flatMap((nameContainer) =>
          childrenNamed(nameContainer, COMMON, "EntityName"),
        );
        return (
          entityNames.length === 0 ||
          entityNames.some(
            (name) => normalizedValue(rawTextContent(name)).length === 0,
          )
        );
      });
    if (hasIncompleteName) {
      incompleteApplicantOrdinals.add(index + 1);
    }
    const partyIdentifierElements = childrenNamed(
      applicant,
      COMMON,
      "PartyIdentifier",
    );
    if (partyIdentifierElements.length > 1) {
      addIssue(issues, {
        code: "cardinality_mismatch",
        status: "review_required",
        message: "An applicant has multiple party identifiers.",
        field: `applicants[${index + 1}].partyIdentifier`,
      });
    }
    const partyIdentifiers = partyIdentifierElements.map((element) =>
      sourceString(
        element,
        issues,
        `applicants[${index + 1}].partyIdentifier`,
      ),
    );
    return {
      ordinal: index + 1,
      sequenceNumber: attributeValue(
        applicant,
        COMMON,
        "sequenceNumber",
      ),
      partyIdentifier: partyIdentifiers[0] ?? null,
      partyIdentifiers,
      names,
    };
  });

  const validNameCount = extracted.reduce(
    (count, applicant) =>
      count + applicant.names.filter((name) => name.value.length > 0).length,
    0,
  );
  if (extracted.length === 0 || validNameCount === 0) {
    addIssue(issues, {
      code: "applicant_name_missing",
      status: "failed",
      message: "No valid applicant name was found at the required XML path.",
      field: applicantsBag?.sourcePath ?? "applicants",
    });
  } else {
    for (const applicant of extracted) {
      if (
        incompleteApplicantOrdinals.has(applicant.ordinal) ||
        !applicant.names.some((name) => name.value.length > 0)
      ) {
        addIssue(issues, {
          code: "applicant_name_missing",
          status: "review_required",
          message: "An applicant has no valid name at the required XML path.",
          field: `applicants[${applicant.ordinal}]`,
        });
      }
    }
  }

  return extracted;
}

function abstractContent(
  abstractElement: XmlTreeElement,
  issues: KohoParseIssue[],
): KohoStructuredContent {
  return renderStructuredContent(abstractElement, issues);
}

function claimWithoutNumber(claim: XmlTreeElement): XmlTreeElement {
  return {
    ...claim,
    children: claim.children.filter(
      (child) =>
        child.type === "text" ||
        !isElementNamed(child.element, PATENT, "ClaimNumber"),
    ),
  };
}

function claimRecords(
  claimElements: XmlTreeElement[],
  issues: KohoParseIssue[],
): KohoClaim[] {
  return claimElements.map((claim, index) => {
    const claimNumberElement = singletonChildNamed(
      claim,
      PATENT,
      "ClaimNumber",
      issues,
      `${claim.sourcePath}/ClaimNumber`,
    );
    const claimNumberSource = claimNumberElement
      ? sourceString(
          claimNumberElement,
          issues,
          `claims[${index + 1}].claimNumber`,
        )
      : null;
    const claimNumber = claimNumberSource?.value || null;
    const content = renderStructuredContent(
      claimWithoutNumber(claim),
      issues,
      "claim",
    );
    return {
      ordinal: index + 1,
      claimNumber,
      claimNumberSource,
      content,
      plainText: content.plainText,
    };
  });
}

function descriptionRecords(
  description: XmlTreeElement | null,
  issues: KohoParseIssue[],
): KohoDescriptionParagraph[] {
  if (!description) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The required description element is missing.",
      field: "description",
    });
    return [];
  }

  const records: KohoDescriptionParagraph[] = [];
  const isKnownStructuralContainer = (element: XmlTreeElement): boolean =>
    (element.namespaceUri === JP_PATENT || element.namespaceUri === PATENT) &&
    knownDescriptionContainerLocalNames.has(element.localName);

  const appendRecord = (
    container: XmlTreeElement,
    children: XmlTreeElement["children"],
    paragraphNumber: string | null,
  ): void => {
    const content = renderStructuredContent(
      { ...container, children },
      issues,
      "paragraph",
    );
    if (!content.tokens.some((token) => token.type !== "boundary")) {
      return;
    }
    records.push({
      ordinal: records.length + 1,
      paragraphNumber,
      content,
      plainText: content.plainText,
    });
  };

  type DescriptionOperation =
    | { type: "container"; container: XmlTreeElement }
    | {
        type: "content";
        container: XmlTreeElement;
        children: XmlTreeElement["children"];
        paragraphNumber: string | null;
      };
  const operations: DescriptionOperation[] = [
    { type: "container", container: description },
  ];

  while (operations.length > 0) {
    const operation = operations.pop();
    if (!operation) {
      break;
    }
    if (operation.type === "content") {
      appendRecord(
        operation.container,
        operation.children,
        operation.paragraphNumber,
      );
      continue;
    }

    const { container } = operation;
    const nextOperations: DescriptionOperation[] = [];
    let pending: XmlTreeElement["children"] = [];
    const flushPending = () => {
      if (pending.length > 0) {
        nextOperations.push({
          type: "content",
          container,
          children: pending,
          paragraphNumber: null,
        });
        pending = [];
      }
    };

    for (const child of container.children) {
      if (
        child.type === "element" &&
        isElementNamed(child.element, COMMON, "P")
      ) {
        flushPending();
        nextOperations.push({
          type: "content",
          container: child.element,
          children: child.element.children,
          paragraphNumber: attributeValue(
            child.element,
            COMMON,
            "pNumber",
          ),
        });
      } else if (
        child.type === "element" &&
        isKnownStructuralContainer(child.element)
      ) {
        flushPending();
        nextOperations.push({ type: "container", container: child.element });
      } else {
        pending.push(child);
      }
    }
    flushPending();
    for (let index = nextOperations.length - 1; index >= 0; index -= 1) {
      operations.push(nextOperations[index]);
    }
  }
  if (
    records.length === 0 ||
    !records.some((record) => record.plainText.trim().length > 0)
  ) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The required description contains no paragraph text.",
      field: description.sourcePath,
    });
  }
  return records;
}

function addMissingClassificationIssue(
  issues: KohoParseIssue[],
  classifications: KohoClassification[],
  field: "ipc" | "fi",
): void {
  if (
    classifications.length === 0 ||
    !classifications.some((classification) => classification.value.length > 0)
  ) {
    addIssue(issues, {
      code: "optional_classification_missing",
      status: "review_required",
      message: "An optional classification is missing or empty.",
      field,
    });
  }
}

export function extractFullPublication(
  root: XmlTreeElement,
  kind: FullPublicationKind,
  rootDefinition: KohoRootDefinition,
  source: KohoXmlSourceMetadata,
  issues: KohoParseIssue[],
): KohoFullPublicationDocument | null {
  const bibliographicData = rootDefinition.bibliographicLocalName
    ? singletonChildNamed(
        root,
        JP_PATENT,
        rootDefinition.bibliographicLocalName,
        issues,
        "bibliographicData",
      )
    : null;
  if (!bibliographicData) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The required bibliographic data element is missing.",
      field: "bibliographicData",
    });
  }

  const publicationIdentification = singletonDirectPath(
    bibliographicData,
    [[JP_PATENT, "PatentPublicationIdentification"]],
    issues,
    "publicationIdentification",
  );
  const applicationIdentification = singletonDirectPath(
    bibliographicData,
    [[JP_PATENT, "ApplicationIdentification"]],
    issues,
    "applicationIdentification",
  );
  const publicationNumber = requiredSourceString(
    singletonDirectPath(
      publicationIdentification,
      [[PATENT, "PublicationNumber"]],
      issues,
      "publicationNumber",
    ),
    issues,
    "publicationNumber",
  );
  const applicationNumber = requiredSourceString(
    singletonDirectPath(
      applicationIdentification,
      [
        [COMMON, "ApplicationNumber"],
        [COMMON, "ApplicationNumberText"],
      ],
      issues,
      "applicationNumber",
    ),
    issues,
    "applicationNumber",
  );
  const applicationDate = dateValue(
    singletonDirectPath(
      applicationIdentification,
      [[PATENT, "FilingDate"]],
      issues,
      "applicationDate",
    ),
    issues,
    "applicationDate",
    true,
  );
  const publicationDate = dateValue(
    singletonDirectPath(
      publicationIdentification,
      [[COMMON, "PublicationDate"]],
      issues,
      "publicationDate",
    ),
    issues,
    "publicationDate",
    true,
  );
  const registrationDate =
    kind === "B1" || kind === "B2"
      ? dateValue(
          singletonDirectPath(
            bibliographicData,
            [[COMMON, "RegistrationDate"]],
            issues,
            "registrationDate",
          ),
          issues,
          "registrationDate",
          true,
        )
      : null;
  const plainLanguageDesignation =
    kind === "B1" || kind === "B2"
      ? optionalSourceString(
          firstChildNamed(
            bibliographicData,
            PATENT,
            "PlainLanguageDesignationText",
          ),
          issues,
          "plainLanguageDesignationText",
        )
      : null;

  const applicants = extractApplicants(
    bibliographicData,
    rootDefinition.partyBagLocalName,
    issues,
  );

  const titleElement = singletonDirectPath(
    bibliographicData,
    [[PATENT, "InventionTitle"]],
    issues,
    "inventionTitle",
  );
  const inventionTitle = titleElement
    ? renderStructuredContent(titleElement, issues)
    : null;
  if (!inventionTitle || inventionTitle.plainText.trim().length === 0) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The required invention title is missing or empty.",
      field: titleElement?.sourcePath ?? "inventionTitle",
    });
  }

  const ipc = classifications(
    singletonDirectPath(
      bibliographicData,
      [[JP_PATENT, "IPCClassification"]],
      issues,
      "ipc",
    ),
    "ipc",
    issues,
  );
  const fi = classifications(
    singletonDirectPath(
      bibliographicData,
      [[JP_PATENT, "NationalClassification"]],
      issues,
      "fi",
    ),
    "fi",
    issues,
  );
  addMissingClassificationIssue(issues, ipc, "ipc");
  addMissingClassificationIssue(issues, fi, "fi");

  const abstractElement = singletonChildNamed(
    root,
    PATENT,
    "Abstract",
    issues,
    "abstract",
  );
  const renderedAbstract = abstractElement
    ? abstractContent(abstractElement, issues)
    : null;
  const abstract =
    renderedAbstract && renderedAbstract.plainText.trim().length > 0
      ? renderedAbstract
      : null;
  if (!abstract && kind !== "B2") {
    addIssue(issues, {
      code: "optional_abstract_missing",
      status: "review_required",
      message: "The abstract is missing for this publication kind.",
      field: "abstract",
    });
  }

  const claimsContainer = singletonChildNamed(
    root,
    PATENT,
    "Claims",
    issues,
    "claims",
  );
  const claimElements = claimsContainer
    ? childrenNamed(claimsContainer, PATENT, "Claim")
    : [];
  const claims = claimRecords(claimElements, issues);
  if (!claimsContainer || claims.length === 0) {
    addIssue(issues, {
      code: "claims_missing",
      status: "failed",
      message: "No claim was found at the required XML path.",
      field: claimsContainer?.sourcePath ?? "claims",
    });
  }

  const description = descriptionRecords(
    singletonChildNamed(
      root,
      JP_PATENT,
      "Description",
      issues,
      "description",
    ),
    issues,
  );
  const embeddedAmendmentBags = childrenNamed(
    root,
    JP_PATENT,
    "WrittenAmendmentBag",
  );
  if (embeddedAmendmentBags.length > 1) {
    addIssue(issues, {
      code: "cardinality_mismatch",
      status: "review_required",
      message:
        "The full publication contains multiple embedded amendment bags.",
      field: "writtenAmendmentBag",
    });
  }
  const amendmentContent = embeddedAmendmentBags.map(toXmlSnapshot);
  const references = collectKohoReferences(
    root,
    source.sourceEntryPath,
    issues,
  );

  if (
    hasFailedIssue(issues) ||
    !publicationNumber ||
    !applicationNumber ||
    !applicationDate ||
    !publicationDate ||
    !inventionTitle ||
    ((kind === "B1" || kind === "B2") && !registrationDate)
  ) {
    return null;
  }

  return {
    kind,
    publicationNumber,
    registrationNumber:
      kind === "B1" || kind === "B2" ? { ...publicationNumber } : null,
    applicationNumber,
    applicationDate,
    publicationDate,
    registrationDate,
    plainLanguageDesignation,
    applicants,
    inventionTitle,
    ipc,
    fi,
    abstract,
    claims,
    description,
    amendmentContent,
    references,
    source,
  };
}

function writtenAmendmentElements(
  bag: XmlTreeElement | null,
): XmlTreeElement[] {
  return bag ? childrenNamed(bag, JP_PATENT, "WrittenAmendment") : [];
}

function outermostDescendantsNamed(
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
      continue;
    }
    const children = childElements(child);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return matches;
}

function amendedClaimElements(
  bag: XmlTreeElement,
  issues: KohoParseIssue[],
): XmlTreeElement[] {
  const claimContainers = outermostDescendantsNamed(bag, PATENT, "Claims");
  return claimContainers.flatMap((claims) => {
    const nestedClaims = outermostDescendantsNamed(claims, PATENT, "Claims");
    if (nestedClaims.length > 0) {
      addIssue(issues, {
        code: "cardinality_mismatch",
        status: "review_required",
        message:
          "A nested amendment Claims subtree was preserved without duplicate claim extraction.",
        field: nestedClaims[0].sourcePath,
      });
    }
    return childrenNamed(claims, PATENT, "Claim");
  });
}

export function extractAmendment(
  root: XmlTreeElement,
  kind: AmendmentKind,
  rootDefinition: KohoRootDefinition,
  source: KohoXmlSourceMetadata,
  issues: KohoParseIssue[],
): KohoAmendmentDocument | null {
  const header = rootDefinition.amendmentHeaderLocalName
    ? singletonChildNamed(
        root,
        JP_PATENT,
        rootDefinition.amendmentHeaderLocalName,
        issues,
        "amendmentHeader",
      )
    : null;
  if (!header) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The required amendment header is missing.",
      field: "amendmentHeader",
    });
  }

  const publicationIdentification = singletonDirectPath(
    header,
    [[JP_PATENT, "PatentPublicationIdentification"]],
    issues,
    "publicationIdentification",
  );
  const applicationIdentification = singletonDirectPath(
    header,
    [[JP_PATENT, "ApplicationIdentification"]],
    issues,
    "applicationIdentification",
  );
  const publicationNumber = requiredSourceString(
    singletonDirectPath(
      publicationIdentification,
      [[PATENT, "PublicationNumber"]],
      issues,
      "publicationNumber",
    ),
    issues,
    "publicationNumber",
  );
  const publicationDate = dateValue(
    singletonDirectPath(
      publicationIdentification,
      [[COMMON, "PublicationDate"]],
      issues,
      "publicationDate",
    ),
    issues,
    "publicationDate",
    true,
  );
  const applicationNumber = requiredSourceString(
    singletonDirectPath(
      applicationIdentification,
      [
        [COMMON, "ApplicationNumber"],
        [COMMON, "ApplicationNumberText"],
      ],
      issues,
      "applicationNumber",
    ),
    issues,
    "applicationNumber",
  );
  const applicationDate = dateValue(
    singletonDirectPath(
      applicationIdentification,
      [[PATENT, "FilingDate"]],
      issues,
      "applicationDate",
    ),
    issues,
    "applicationDate",
    false,
  );
  const correctedPublicationCategory = requiredSourceString(
    singletonDirectPath(
      header,
      [[JP_PATENT, "CorrectedPublicationCategory"]],
      issues,
      "correctedPublicationCategory",
    ),
    issues,
    "correctedPublicationCategory",
  );

  const ipc = classifications(
    singletonDirectPath(
      header,
      [[JP_PATENT, "IPCClassification"]],
      issues,
      "ipc",
    ),
    "ipc",
    issues,
  );
  const fi = classifications(
    singletonDirectPath(
      header,
      [[JP_PATENT, "NationalClassification"]],
      issues,
      "fi",
    ),
    "fi",
    issues,
  );

  const amendmentBag = singletonChildNamed(
    root,
    JP_PATENT,
    "WrittenAmendmentBag",
    issues,
    "writtenAmendmentBag",
  );
  if (!amendmentBag) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The required written amendment content is missing.",
      field: "writtenAmendmentBag",
    });
  }

  const writtenAmendments = writtenAmendmentElements(amendmentBag);
  if (amendmentBag && writtenAmendments.length === 0) {
    addIssue(issues, {
      code: "required_field_missing",
      status: "failed",
      message: "The amendment contains no WrittenAmendment element.",
      field: amendmentBag.sourcePath,
    });
  }
  const writtenAmendmentFilingDates = writtenAmendments.flatMap(
    (writtenAmendment) => {
      const filingDate = dateValue(
        singletonChildNamed(
          writtenAmendment,
          PATENT,
          "FilingDate",
          issues,
          `${writtenAmendment.sourcePath}/FilingDate`,
        ),
        issues,
        `${writtenAmendment.sourcePath}/FilingDate`,
        true,
      );
      return filingDate ? [filingDate] : [];
    },
  );
  const amendedClaims = amendmentBag
    ? claimRecords(amendedClaimElements(amendmentBag, issues), issues)
    : [];

  const nationalPublicationNumber =
    kind === "P5"
      ? optionalSourceString(
          singletonChildNamed(
            header,
            JP_PATENT,
            "NationalPublicationNumber",
            issues,
            "nationalPublicationNumber",
          ),
          issues,
          "nationalPublicationNumber",
        )
      : null;
  const previousPublicationDate =
    kind === "P5"
      ? dateValue(
          singletonChildNamed(
            header,
            JP_PATENT,
            "PreviousPublicationDate",
            issues,
            "previousPublicationDate",
          ),
          issues,
          "previousPublicationDate",
          false,
        )
      : null;
  const annualNumber =
    kind === "P5"
      ? optionalSourceString(
          singletonChildNamed(
            header,
            JP_PATENT,
            "AnnualNumber",
            issues,
            "annualNumber",
          ),
          issues,
          "annualNumber",
        )
      : null;
  const references = collectKohoReferences(
    root,
    source.sourceEntryPath,
    issues,
  );

  if (
    hasFailedIssue(issues) ||
    !publicationNumber ||
    !applicationNumber ||
    !publicationDate ||
    !correctedPublicationCategory ||
    !amendmentBag
  ) {
    return null;
  }

  return {
    kind,
    publicationNumber,
    applicationNumber,
    publicationDate,
    applicationDate,
    correctedPublicationCategory,
    ipc,
    fi,
    writtenAmendmentFilingDates,
    amendedClaims,
    nationalPublicationNumber,
    previousPublicationDate,
    annualNumber,
    contentExtraction: "structured_snapshot",
    amendmentContent: toXmlSnapshot(amendmentBag),
    references,
    source,
  };
}
