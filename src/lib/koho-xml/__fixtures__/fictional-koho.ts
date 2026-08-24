import { KOHO_NAMESPACES } from "../constants";
import type {
  KohoDocumentKind,
  KohoPackageType,
  KohoXmlParseInput,
} from "../types";

export type FictionalFullPublicationKind = Extract<
  KohoDocumentKind,
  "A1" | "P1" | "B1" | "B2"
>;

export type FictionalAmendmentKind = Extract<KohoDocumentKind, "A5" | "P5">;

export interface FictionalKohoPrefixes {
  jppat: string;
  jpcom: string;
  pat: string;
  com: string;
  xsi: string;
}

export interface FictionalApplicantName {
  value: string;
  originalLanguageIndicator?: boolean | null;
}

export interface FictionalApplicant {
  sequenceNumber?: string | null;
  partyIdentifier?: string | null;
  names: readonly (string | FictionalApplicantName)[];
}

export interface FictionalNumberedText {
  number?: string | null;
  text: string;
}

export interface FictionalMixedContentTargets {
  inventionTitle?: boolean;
  abstract?: boolean;
  firstClaim?: boolean;
  firstParagraph?: boolean;
}

interface FictionalRootOptions {
  prefixes?: Partial<FictionalKohoPrefixes>;
  schemaBasename?: string | null;
  languageCode?: string | null;
  st96Version?: string | null;
  ipoVersion?: string | null;
}

export interface FictionalFullPublicationXmlOptions
  extends FictionalRootOptions {
  publicationNumber?: string | null;
  applicationNumber?: string | null;
  applicationDate?: string | null;
  publicationDate?: string | null;
  registrationDate?: string | null;
  plainLanguageDesignationText?: string | null;
  applicants?: readonly FictionalApplicant[] | null;
  inventionTitle?: string | null;
  ipc?: readonly string[] | null;
  fi?: readonly string[] | null;
  abstract?: string | null;
  includeAbstract?: boolean;
  claims?: readonly FictionalNumberedText[] | null;
  paragraphs?: readonly FictionalNumberedText[] | null;
  mixedContent?: boolean | FictionalMixedContentTargets;
}

export interface FictionalAmendmentXmlOptions extends FictionalRootOptions {
  publicationNumber?: string | null;
  applicationNumber?: string | null;
  applicationDate?: string | null;
  publicationDate?: string | null;
  correctedPublicationCategory?: string | null;
  ipc?: readonly string[] | null;
  fi?: readonly string[] | null;
  includeWrittenAmendmentBag?: boolean;
  writtenAmendmentFilingDates?: readonly string[] | null;
  amendedClaims?: readonly FictionalNumberedText[] | null;
  nationalPublicationNumber?: string | null;
  previousPublicationDate?: string | null;
  annualNumber?: string | null;
  mixedContent?: boolean;
}

export interface FictionalKohoInputOptions {
  xml?: string | Uint8Array;
  entryPath?: string;
  indexHint?: KohoXmlParseInput["indexHint"] | null;
  limits?: Partial<KohoXmlParseInput["limits"]>;
}

interface FictionalKindDefinition {
  packageType: KohoPackageType;
  section: "P_A1" | "P_A5" | "P_P1" | "P_P5" | "P_B1";
  rootLocalName: string;
  schemaBasename: string;
  publicationNumber: string;
  applicationNumber: string;
  applicationDate: string;
  publicationDate: string;
  indexPublicationDate: string;
  indexKindCode: "A" | "A5" | "B1" | "B2";
  bibliographicLocalName?: string;
  partyBagLocalName?: string;
  amendmentHeaderLocalName?: string;
  registrationDate?: string;
  plainLanguageDesignationText?: string;
}

const DEFAULT_PREFIXES: FictionalKohoPrefixes = {
  jppat: "jppat",
  jpcom: "jpcom",
  pat: "pat",
  com: "com",
  xsi: "xsi",
};

const KIND_DEFINITIONS = {
  A1: {
    packageType: "JPA",
    section: "P_A1",
    rootLocalName: "UnexaminedPatentPublication",
    schemaBasename: "JPUnexaminedPatentPublication_V1_0.xsd",
    publicationNumber: "2099000001",
    applicationNumber: "FICTIONAL-APPLICATION-A1-0001",
    applicationDate: "2098-01-01",
    publicationDate: "2099-01-11",
    indexPublicationDate: "20990111",
    indexKindCode: "A",
    bibliographicLocalName:
      "UnexaminedPatentPublicationBibliographicData",
    partyBagLocalName: "UnexaminedPatentPublicationPartyBag",
  },
  A5: {
    packageType: "JPA",
    section: "P_A5",
    rootLocalName: "UnexaminedPatentPublicationAmendment",
    schemaBasename: "JPUnexaminedPatentPublicationAmendment_V1_0.xsd",
    publicationNumber: "2099000005",
    applicationNumber: "FICTIONAL-APPLICATION-A5-0005",
    applicationDate: "2098-01-05",
    publicationDate: "2099-01-15",
    indexPublicationDate: "20990115",
    indexKindCode: "A5",
    amendmentHeaderLocalName:
      "UnexaminedPatentPublicationAmendmentHeader",
  },
  P1: {
    packageType: "JPA",
    section: "P_P1",
    rootLocalName: "InternationalPatentPublication",
    schemaBasename: "JPInternationalPatentPublication_V1_0.xsd",
    publicationNumber: "WO2099000001",
    applicationNumber: "FICTIONAL-APPLICATION-P1-0001",
    applicationDate: "2098-02-01",
    publicationDate: "2099-02-11",
    indexPublicationDate: "20990211",
    indexKindCode: "A",
    bibliographicLocalName:
      "InternationalPatentPublicationBibliographicData",
    partyBagLocalName: "InternationalPatentPublicationPartyBag",
  },
  P5: {
    packageType: "JPA",
    section: "P_P5",
    rootLocalName: "InternationalPatentPublicationAmendment",
    schemaBasename: "JPInternationalPatentPublicationAmendment_V1_0.xsd",
    publicationNumber: "WO2099000005",
    applicationNumber: "FICTIONAL-APPLICATION-P5-0005",
    applicationDate: "2098-02-05",
    publicationDate: "2099-02-15",
    indexPublicationDate: "20990215",
    indexKindCode: "A5",
    amendmentHeaderLocalName:
      "InternationalPatentPublicationAmendmentHeader",
  },
  B1: {
    packageType: "JPB",
    section: "P_B1",
    rootLocalName: "RegisteredPatentPublication",
    schemaBasename: "JPRegisteredPatentPublication_V1_0.xsd",
    publicationNumber: "9999991",
    applicationNumber: "FICTIONAL-APPLICATION-B1-0001",
    applicationDate: "2098-03-01",
    publicationDate: "2099-03-11",
    indexPublicationDate: "20990311",
    indexKindCode: "B1",
    bibliographicLocalName: "RegisteredPatentPublicationBibliographicData",
    partyBagLocalName: "RegisteredPatentPublicationPartyBag",
    registrationDate: "2099-03-01",
    plainLanguageDesignationText: "特許公報(B1)",
  },
  B2: {
    packageType: "JPB",
    section: "P_B1",
    rootLocalName: "RegisteredPatentPublication",
    schemaBasename: "JPRegisteredPatentPublication_V1_0.xsd",
    publicationNumber: "9999992",
    applicationNumber: "FICTIONAL-APPLICATION-B2-0002",
    applicationDate: "2098-03-02",
    publicationDate: "2099-03-12",
    indexPublicationDate: "20990312",
    indexKindCode: "B2",
    bibliographicLocalName: "RegisteredPatentPublicationBibliographicData",
    partyBagLocalName: "RegisteredPatentPublicationPartyBag",
    registrationDate: "2099-03-02",
    plainLanguageDesignationText: "特許公報(B2)",
  },
} as const satisfies Record<KohoDocumentKind, FictionalKindDefinition>;

const DEFAULT_APPLICANTS: readonly FictionalApplicant[] = [
  {
    sequenceNumber: "1",
    partyIdentifier: "FICTIONAL-PARTY-0001",
    names: [
      {
        value: "架空第一雲研究株式会社",
        originalLanguageIndicator: true,
      },
      {
        value: "Fictional First Cloud Research Inc.",
        originalLanguageIndicator: false,
      },
    ],
  },
  {
    sequenceNumber: "2",
    partyIdentifier: "FICTIONAL-PARTY-0002",
    names: ["架空第二月面試験組合"],
  },
];

const DEFAULT_IPC = [
  "FICTIONAL-IPC-MAIN",
  "FICTIONAL-IPC-FURTHER",
] as const;

const DEFAULT_FI = ["FICTIONAL-FI-MAIN", "FICTIONAL-FI-FURTHER"] as const;

const DEFAULT_CLAIMS: readonly FictionalNumberedText[] = [
  {
    number: "1",
    text: "架空試験用の雲型パンを月面で整列させる架空装置。",
  },
  {
    number: "2",
    text: "請求項1の架空装置を虹色に点滅させる架空制御方法。",
  },
];

const DEFAULT_PARAGRAPHS: readonly FictionalNumberedText[] = [
  {
    number: "0001",
    text: "本段落は実在しない発明を説明する架空試験データである。",
  },
  {
    number: "0002",
    text: "架空の雲型パンと架空の月面整列器との関係を説明する。",
  },
];

export const FICTIONAL_KOHO_LIMITS: KohoXmlParseInput["limits"] = {
  maxXmlBytes: 1_048_576,
  maxDepth: 64,
  maxElements: 10_000,
  maxTextBytes: 524_288,
};

function optionOrDefault<T>(value: T | null | undefined, fallback: T): T | null {
  return value === undefined ? fallback : value;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolvePrefixes(
  overrides: Partial<FictionalKohoPrefixes> | undefined,
): FictionalKohoPrefixes {
  const prefixes = { ...DEFAULT_PREFIXES, ...overrides };
  const values = Object.values(prefixes);
  const validPrefix = /^[A-Za-z_][A-Za-z0-9._-]*$/;
  if (
    values.some((prefix) => !validPrefix.test(prefix)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Fixture namespace prefixes must be valid and distinct.");
  }
  return prefixes;
}

function validateSchemaBasename(schemaBasename: string): void {
  if (
    schemaBasename.length === 0 ||
    schemaBasename === "." ||
    schemaBasename === ".." ||
    schemaBasename.includes("/") ||
    schemaBasename.includes("\\") ||
    schemaBasename.includes("\0")
  ) {
    throw new Error("Fixture schema basename must be a safe ZIP basename.");
  }
}

function qname(prefix: string, localName: string): string {
  return `${prefix}:${localName}`;
}

function renderElement(
  name: string,
  value: string | null,
  indent: string,
): string | null {
  return value === null
    ? null
    : `${indent}<${name}>${escapeXmlText(value)}</${name}>`;
}

function compact(lines: readonly (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null);
}

function shouldInsertMixedContent(
  mixedContent: boolean | FictionalMixedContentTargets | undefined,
  target: keyof FictionalMixedContentTargets,
): boolean {
  return mixedContent === true ||
    (typeof mixedContent === "object" && mixedContent[target] === true);
}

function renderMixedContent(
  baseText: string,
  prefixes: FictionalKohoPrefixes,
): string {
  const com = prefixes.com;
  return [
    escapeXmlText(`${baseText} 架空前部`),
    `<${qname(com, "B")}>架空強調部</${qname(com, "B")}>`,
    "架空後部",
    `<${qname(com, "Br")}/>`,
    "架空改行後",
    `<${qname(com, "FigureReference")} ${qname(com, "referencedFigureNumber")}="FICTIONAL-FIGURE-1">架空図参照</${qname(com, "FigureReference")}>`,
    "架空末尾 &lt;FICTIONAL-ST25-TAG&gt;",
  ].join("");
}

function renderContent(
  value: string,
  prefixes: FictionalKohoPrefixes,
  includeMixedContent: boolean,
): string {
  return includeMixedContent
    ? renderMixedContent(value, prefixes)
    : escapeXmlText(value);
}

function renderRootOpen(
  rootLocalName: string,
  expectedSchemaBasename: string,
  options: FictionalRootOptions,
  prefixes: FictionalKohoPrefixes,
): string {
  const schemaBasename = optionOrDefault(
    options.schemaBasename,
    expectedSchemaBasename,
  );
  if (schemaBasename !== null) {
    validateSchemaBasename(schemaBasename);
  }

  const languageCode = optionOrDefault(options.languageCode, "ja");
  const st96Version = optionOrDefault(options.st96Version, "V3_1");
  const ipoVersion = optionOrDefault(options.ipoVersion, "JP_V1_0");
  const attributes = compact([
    `xmlns:${prefixes.jppat}="${KOHO_NAMESPACES.jpPatent}"`,
    `xmlns:${prefixes.jpcom}="${KOHO_NAMESPACES.jpCommon}"`,
    `xmlns:${prefixes.pat}="${KOHO_NAMESPACES.patent}"`,
    `xmlns:${prefixes.com}="${KOHO_NAMESPACES.common}"`,
    `xmlns:${prefixes.xsi}="${KOHO_NAMESPACES.xsi}"`,
    languageCode === null
      ? null
      : `${qname(prefixes.com, "languageCode")}="${escapeXmlAttribute(languageCode)}"`,
    st96Version === null
      ? null
      : `${qname(prefixes.com, "st96Version")}="${escapeXmlAttribute(st96Version)}"`,
    ipoVersion === null
      ? null
      : `${qname(prefixes.com, "ipoVersion")}="${escapeXmlAttribute(ipoVersion)}"`,
    schemaBasename === null
      ? null
      : `${qname(prefixes.xsi, "schemaLocation")}="${KOHO_NAMESPACES.jpPatent} ../../../../../XSD/${escapeXmlAttribute(schemaBasename)}"`,
  ]);

  return `<${qname(prefixes.jppat, rootLocalName)}\n  ${attributes.join("\n  ")}>`;
}

function renderPublicationIdentification(
  publicationNumber: string | null,
  publicationDate: string | null,
  prefixes: FictionalKohoPrefixes,
  indent: string,
): string | null {
  if (publicationNumber === null && publicationDate === null) {
    return null;
  }
  return compact([
    `${indent}<${qname(prefixes.jppat, "PatentPublicationIdentification")}>`,
    renderElement(
      qname(prefixes.pat, "PublicationNumber"),
      publicationNumber,
      `${indent}  `,
    ),
    renderElement(
      qname(prefixes.com, "PublicationDate"),
      publicationDate,
      `${indent}  `,
    ),
    `${indent}</${qname(prefixes.jppat, "PatentPublicationIdentification")}>`,
  ]).join("\n");
}

function renderApplicationIdentification(
  applicationNumber: string | null,
  applicationDate: string | null,
  prefixes: FictionalKohoPrefixes,
  indent: string,
): string | null {
  if (applicationNumber === null && applicationDate === null) {
    return null;
  }
  const applicationNumberXml =
    applicationNumber === null
      ? null
      : [
          `${indent}  <${qname(prefixes.com, "ApplicationNumber")}>`,
          `${indent}    <${qname(prefixes.com, "ApplicationNumberText")}>${escapeXmlText(applicationNumber)}</${qname(prefixes.com, "ApplicationNumberText")}>`,
          `${indent}  </${qname(prefixes.com, "ApplicationNumber")}>`,
        ].join("\n");
  return compact([
    `${indent}<${qname(prefixes.jppat, "ApplicationIdentification")}>`,
    applicationNumberXml,
    renderElement(
      qname(prefixes.pat, "FilingDate"),
      applicationDate,
      `${indent}  `,
    ),
    `${indent}</${qname(prefixes.jppat, "ApplicationIdentification")}>`,
  ]).join("\n");
}

function renderApplicants(
  applicants: readonly FictionalApplicant[] | null,
  partyBagLocalName: string,
  prefixes: FictionalKohoPrefixes,
): string | null {
  if (applicants === null) {
    return null;
  }

  const renderedApplicants = applicants.map((applicant, applicantIndex) => {
    const sequenceNumber = optionOrDefault(
      applicant.sequenceNumber,
      String(applicantIndex + 1),
    );
    const partyIdentifier = optionOrDefault(
      applicant.partyIdentifier,
      `FICTIONAL-PARTY-${String(applicantIndex + 1).padStart(4, "0")}`,
    );
    const applicantAttribute =
      sequenceNumber === null
        ? ""
        : ` ${qname(prefixes.com, "sequenceNumber")}="${escapeXmlAttribute(sequenceNumber)}"`;
    const names = applicant.names.map((name) => {
      const normalized = typeof name === "string" ? { value: name } : name;
      const originalLanguageIndicator =
        normalized.originalLanguageIndicator === undefined ||
        normalized.originalLanguageIndicator === null
          ? ""
          : ` ${qname(prefixes.jpcom, "OriginalLanguageIndicator")}="${normalized.originalLanguageIndicator ? "true" : "false"}"`;
      return [
        `          <${qname(prefixes.jpcom, "Contact")}${originalLanguageIndicator}>`,
        `            <${qname(prefixes.com, "Name")}>`,
        `              <${qname(prefixes.com, "EntityName")}>${escapeXmlText(normalized.value)}</${qname(prefixes.com, "EntityName")}>`,
        `            </${qname(prefixes.com, "Name")}>`,
        `          </${qname(prefixes.jpcom, "Contact")}>`,
      ].join("\n");
    });

    return compact([
      `      <${qname(prefixes.jppat, "ApplicantRegisteredPractitionerBag")}>`,
      `        <${qname(prefixes.jppat, "Applicant")}${applicantAttribute}>`,
      renderElement(
        qname(prefixes.com, "PartyIdentifier"),
        partyIdentifier,
        "          ",
      ),
      ...names,
      `        </${qname(prefixes.jppat, "Applicant")}>`,
      `      </${qname(prefixes.jppat, "ApplicantRegisteredPractitionerBag")}>`,
    ]).join("\n");
  });

  return [
    `    <${qname(prefixes.jppat, partyBagLocalName)}>`,
    `      <${qname(prefixes.jppat, "ApplicantsRegisteredPractitionersBag")}>`,
    ...renderedApplicants,
    `      </${qname(prefixes.jppat, "ApplicantsRegisteredPractitionersBag")}>`,
    `    </${qname(prefixes.jppat, partyBagLocalName)}>`,
  ].join("\n");
}

function renderClassifications(
  values: readonly string[] | null,
  containerLocalName: "IPCClassification" | "NationalClassification",
  mainLocalName: string,
  furtherLocalName: string,
  leafPrefix: string | null,
  leafLocalName: string | null,
  prefixes: FictionalKohoPrefixes,
  indent: string,
): string | null {
  if (values === null) {
    return null;
  }
  const items = values.map((value, index) => {
    const classificationLocalName =
      index === 0 ? mainLocalName : furtherLocalName;
    if (leafPrefix === null || leafLocalName === null) {
      return `${indent}  <${qname(prefixes.pat, classificationLocalName)}>${escapeXmlText(value)}</${qname(prefixes.pat, classificationLocalName)}>`;
    }
    return [
      `${indent}  <${qname(prefixes.jppat, classificationLocalName)}>`,
      `${indent}    <${qname(leafPrefix, leafLocalName)}>${escapeXmlText(value)}</${qname(leafPrefix, leafLocalName)}>`,
      `${indent}  </${qname(prefixes.jppat, classificationLocalName)}>`,
    ].join("\n");
  });
  return [
    `${indent}<${qname(prefixes.jppat, containerLocalName)}>`,
    ...items,
    `${indent}</${qname(prefixes.jppat, containerLocalName)}>`,
  ].join("\n");
}

function renderIpc(
  values: readonly string[] | null,
  prefixes: FictionalKohoPrefixes,
  indent: string,
): string | null {
  return renderClassifications(
    values,
    "IPCClassification",
    "MainClassification",
    "FurtherClassification",
    null,
    null,
    prefixes,
    indent,
  );
}

function renderFi(
  values: readonly string[] | null,
  prefixes: FictionalKohoPrefixes,
  indent: string,
): string | null {
  return renderClassifications(
    values,
    "NationalClassification",
    "MainNationalClassification",
    "FurtherNationalClassification",
    prefixes.pat,
    "PatentClassificationText",
    prefixes,
    indent,
  );
}

function renderClaims(
  claims: readonly FictionalNumberedText[] | null,
  prefixes: FictionalKohoPrefixes,
  indent: string,
  includeMixedContent: boolean,
): string | null {
  if (claims === null) {
    return null;
  }
  const renderedClaims = claims.map((claim, index) => {
    const number = optionOrDefault(claim.number, String(index + 1));
    return compact([
      `${indent}  <${qname(prefixes.pat, "Claim")}>`,
      renderElement(
        qname(prefixes.pat, "ClaimNumber"),
        number,
        `${indent}    `,
      ),
      `${indent}    <${qname(prefixes.pat, "ClaimText")}>${renderContent(
        claim.text,
        prefixes,
        includeMixedContent && index === 0,
      )}</${qname(prefixes.pat, "ClaimText")}>`,
      `${indent}  </${qname(prefixes.pat, "Claim")}>`,
    ]).join("\n");
  });
  return [
    `${indent}<${qname(prefixes.pat, "Claims")}>`,
    ...renderedClaims,
    `${indent}</${qname(prefixes.pat, "Claims")}>`,
  ].join("\n");
}

/**
 * 実在の公報・出願人・発明を含まないfull publication XMLを生成する。
 */
export function buildFictionalFullPublicationXml(
  kind: FictionalFullPublicationKind,
  options: FictionalFullPublicationXmlOptions = {},
): string {
  const definition: FictionalKindDefinition = KIND_DEFINITIONS[kind];
  const prefixes = resolvePrefixes(options.prefixes);
  const rootName = qname(prefixes.jppat, definition.rootLocalName);
  const publicationNumber = optionOrDefault(
    options.publicationNumber,
    definition.publicationNumber,
  );
  const applicationNumber = optionOrDefault(
    options.applicationNumber,
    definition.applicationNumber,
  );
  const applicationDate = optionOrDefault(
    options.applicationDate,
    definition.applicationDate,
  );
  const publicationDate = optionOrDefault(
    options.publicationDate,
    definition.publicationDate,
  );
  const registrationDate = optionOrDefault(
    options.registrationDate,
    definition.registrationDate ?? null,
  );
  const plainLanguageDesignationText = optionOrDefault(
    options.plainLanguageDesignationText,
    definition.plainLanguageDesignationText ?? null,
  );
  const applicants = optionOrDefault(options.applicants, DEFAULT_APPLICANTS);
  const inventionTitle = optionOrDefault(
    options.inventionTitle,
    "架空試験用の月面雲型パン整列装置",
  );
  const ipc = optionOrDefault(options.ipc, DEFAULT_IPC);
  const fi = optionOrDefault(options.fi, DEFAULT_FI);
  const claims = optionOrDefault(options.claims, DEFAULT_CLAIMS);
  const paragraphs = optionOrDefault(options.paragraphs, DEFAULT_PARAGRAPHS);
  const abstract =
    options.abstract !== undefined
      ? options.abstract
      : options.includeAbstract === false || kind === "B2"
        ? null
        : "架空の月面で雲型パンを整列させる架空試験用装置の要約。";
  const bibliographicLocalName = definition.bibliographicLocalName;
  const partyBagLocalName = definition.partyBagLocalName;
  if (!bibliographicLocalName || !partyBagLocalName) {
    throw new Error(`Fixture definition for ${kind} is not a full publication.`);
  }

  const bibliographicXml = compact([
    `  <${qname(prefixes.jppat, bibliographicLocalName)}>`,
    renderPublicationIdentification(
      publicationNumber,
      publicationDate,
      prefixes,
      "    ",
    ),
    renderApplicationIdentification(
      applicationNumber,
      applicationDate,
      prefixes,
      "    ",
    ),
    renderElement(
      qname(prefixes.pat, "PlainLanguageDesignationText"),
      plainLanguageDesignationText,
      "    ",
    ),
    renderElement(
      qname(prefixes.com, "RegistrationDate"),
      registrationDate,
      "    ",
    ),
    renderApplicants(applicants, partyBagLocalName, prefixes),
    inventionTitle === null
      ? null
      : `    <${qname(prefixes.pat, "InventionTitle")}>${renderContent(
          inventionTitle,
          prefixes,
          shouldInsertMixedContent(options.mixedContent, "inventionTitle"),
        )}</${qname(prefixes.pat, "InventionTitle")}>`,
    renderIpc(ipc, prefixes, "    "),
    renderFi(fi, prefixes, "    "),
    `  </${qname(prefixes.jppat, bibliographicLocalName)}>`,
  ]).join("\n");

  const abstractXml =
    abstract === null
      ? null
      : [
          `  <${qname(prefixes.pat, "Abstract")}>`,
          `    <${qname(prefixes.com, "P")} ${qname(prefixes.com, "pNumber")}="0001">${renderContent(
            abstract,
            prefixes,
            shouldInsertMixedContent(options.mixedContent, "abstract"),
          )}</${qname(prefixes.com, "P")}>`,
          `  </${qname(prefixes.pat, "Abstract")}>`,
        ].join("\n");

  const descriptionXml =
    paragraphs === null
      ? null
      : [
          `  <${qname(prefixes.jppat, "Description")}>`,
          ...paragraphs.map((paragraph, index) => {
            const number = optionOrDefault(
              paragraph.number,
              String(index + 1).padStart(4, "0"),
            );
            const numberAttribute =
              number === null
                ? ""
                : ` ${qname(prefixes.com, "pNumber")}="${escapeXmlAttribute(number)}"`;
            return `    <${qname(prefixes.com, "P")}${numberAttribute}>${renderContent(
              paragraph.text,
              prefixes,
              shouldInsertMixedContent(
                options.mixedContent,
                "firstParagraph",
              ) && index === 0,
            )}</${qname(prefixes.com, "P")}>`;
          }),
          `  </${qname(prefixes.jppat, "Description")}>`,
        ].join("\n");

  return compact([
    '<?xml version="1.0" encoding="UTF-8"?>',
    renderRootOpen(
      definition.rootLocalName,
      definition.schemaBasename,
      options,
      prefixes,
    ),
    bibliographicXml,
    abstractXml,
    renderClaims(
      claims,
      prefixes,
      "  ",
      shouldInsertMixedContent(options.mixedContent, "firstClaim"),
    ),
    descriptionXml,
    `</${rootName}>`,
  ]).join("\n");
}

function renderWrittenAmendmentBag(
  filingDates: readonly string[] | null,
  amendedClaims: readonly FictionalNumberedText[] | null,
  prefixes: FictionalKohoPrefixes,
  includeMixedContent: boolean,
): string {
  const dates = filingDates ?? [];
  const amendmentCount = Math.max(dates.length, amendedClaims === null ? 0 : 1);
  const writtenAmendments = Array.from(
    { length: amendmentCount },
    (_unused, index) =>
      compact([
        `    <${qname(prefixes.jppat, "WrittenAmendment")}>`,
        renderElement(
          qname(prefixes.pat, "FilingDate"),
          dates[index] ?? null,
          "      ",
        ),
        index === 0
          ? renderClaims(
              amendedClaims,
              prefixes,
              "      ",
              includeMixedContent,
            )
          : null,
        `    </${qname(prefixes.jppat, "WrittenAmendment")}>`,
      ]).join("\n"),
  );
  return [
    `  <${qname(prefixes.jppat, "WrittenAmendmentBag")}>`,
    ...writtenAmendments,
    `  </${qname(prefixes.jppat, "WrittenAmendmentBag")}>`,
  ].join("\n");
}

/**
 * 実在の補正掲載eventを参照しないA5/P5 amendment XMLを生成する。
 */
export function buildFictionalAmendmentXml(
  kind: FictionalAmendmentKind,
  options: FictionalAmendmentXmlOptions = {},
): string {
  const definition: FictionalKindDefinition = KIND_DEFINITIONS[kind];
  const prefixes = resolvePrefixes(options.prefixes);
  const rootName = qname(prefixes.jppat, definition.rootLocalName);
  const publicationNumber = optionOrDefault(
    options.publicationNumber,
    definition.publicationNumber,
  );
  const applicationNumber = optionOrDefault(
    options.applicationNumber,
    definition.applicationNumber,
  );
  const applicationDate = optionOrDefault(
    options.applicationDate,
    definition.applicationDate,
  );
  const publicationDate = optionOrDefault(
    options.publicationDate,
    definition.publicationDate,
  );
  const correctedPublicationCategory = optionOrDefault(
    options.correctedPublicationCategory,
    "FICTIONAL-AMENDMENT-CATEGORY",
  );
  const ipc = optionOrDefault(options.ipc, DEFAULT_IPC);
  const fi = optionOrDefault(options.fi, DEFAULT_FI);
  const filingDates = optionOrDefault(options.writtenAmendmentFilingDates, [
    "2099-01-01",
    "2099-01-02",
  ]);
  const amendedClaims = optionOrDefault(options.amendedClaims, [
    {
      number: "1",
      text: "架空補正後の雲型パン整列装置に関する架空請求項。",
    },
    {
      number: "2",
      text: "架空補正後の虹色点滅方法に関する架空請求項。",
    },
  ]);
  const nationalPublicationNumber = optionOrDefault(
    options.nationalPublicationNumber,
    kind === "P5" ? "FICTIONAL-NATIONAL-PUBLICATION-P5" : null,
  );
  const previousPublicationDate = optionOrDefault(
    options.previousPublicationDate,
    kind === "P5" ? "2098-12-31" : null,
  );
  const annualNumber = optionOrDefault(
    options.annualNumber,
    kind === "P5" ? "FICTIONAL-ANNUAL-P5" : null,
  );
  const amendmentHeaderLocalName = definition.amendmentHeaderLocalName;
  if (!amendmentHeaderLocalName) {
    throw new Error(`Fixture definition for ${kind} is not an amendment.`);
  }

  const headerXml = compact([
    `  <${qname(prefixes.jppat, amendmentHeaderLocalName)}>`,
    renderPublicationIdentification(
      publicationNumber,
      publicationDate,
      prefixes,
      "    ",
    ),
    renderApplicationIdentification(
      applicationNumber,
      applicationDate,
      prefixes,
      "    ",
    ),
    renderElement(
      qname(prefixes.jppat, "CorrectedPublicationCategory"),
      correctedPublicationCategory,
      "    ",
    ),
    renderIpc(ipc, prefixes, "    "),
    renderFi(fi, prefixes, "    "),
    renderElement(
      qname(prefixes.jppat, "NationalPublicationNumber"),
      nationalPublicationNumber,
      "    ",
    ),
    renderElement(
      qname(prefixes.jppat, "PreviousPublicationDate"),
      previousPublicationDate,
      "    ",
    ),
    renderElement(
      qname(prefixes.jppat, "AnnualNumber"),
      annualNumber,
      "    ",
    ),
    `  </${qname(prefixes.jppat, amendmentHeaderLocalName)}>`,
  ]).join("\n");

  return compact([
    '<?xml version="1.0" encoding="UTF-8"?>',
    renderRootOpen(
      definition.rootLocalName,
      definition.schemaBasename,
      options,
      prefixes,
    ),
    headerXml,
    options.includeWrittenAmendmentBag === false
      ? null
      : renderWrittenAmendmentBag(
          filingDates,
          amendedClaims,
          prefixes,
          options.mixedContent === true,
        ),
    `</${rootName}>`,
  ]).join("\n");
}

export function fictionalPrimaryEntryPath(kind: KohoDocumentKind): string {
  const definition = KIND_DEFINITIONS[kind];
  const documentNumber = definition.publicationNumber;
  return `DOCUMENT/${definition.section}/999900/999990/${documentNumber}/${documentNumber}.xml`;
}

/** kindに対応する安全なprimary path、索引hint、上限を含むparse inputを返す。 */
export function createFictionalKohoInput(
  kind: KohoDocumentKind,
  options: FictionalKohoInputOptions = {},
): KohoXmlParseInput {
  const definition = KIND_DEFINITIONS[kind];
  const defaultXml =
    kind === "A5" || kind === "P5"
      ? buildFictionalAmendmentXml(kind)
      : buildFictionalFullPublicationXml(kind);
  const defaultIndexHint: NonNullable<KohoXmlParseInput["indexHint"]> = {
    kindCode: definition.indexKindCode,
    publicationNumber: definition.publicationNumber,
    publicationDate: definition.indexPublicationDate,
  };
  const indexHint =
    options.indexHint === undefined ? defaultIndexHint : options.indexHint;

  return {
    packageType: definition.packageType,
    entryPath: options.entryPath ?? fictionalPrimaryEntryPath(kind),
    xml: options.xml ?? defaultXml,
    ...(indexHint === null ? {} : { indexHint }),
    limits: {
      ...FICTIONAL_KOHO_LIMITS,
      ...options.limits,
    },
  };
}

export const FICTIONAL_NESTED_ST26_ENTRY_PATH =
  "DOCUMENT/P_A1/999900/999990/2099000001/FICTIONAL-ST26-ATTACHMENT/FICTIONAL-ST26.xml";

export const FICTIONAL_NESTED_ST26_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ST26SequenceListing dtdVersion="V1_3">
  <ApplicationIdentification>
    <IPOfficeCode>ZZ</IPOfficeCode>
    <ApplicationNumberText>FICTIONAL-ST26-APPLICATION</ApplicationNumberText>
  </ApplicationIdentification>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq>
      <INSDSeq_definition>FICTIONAL-SEQUENCE-NOT-FOR-BIOLOGICAL-USE</INSDSeq_definition>
    </INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;

export const FICTIONAL_NESTED_ST26_FIXTURE = {
  entryPath: FICTIONAL_NESTED_ST26_ENTRY_PATH,
  xml: FICTIONAL_NESTED_ST26_XML,
} as const;
