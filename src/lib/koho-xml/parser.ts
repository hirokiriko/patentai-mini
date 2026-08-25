import {
  EXPECTED_IPO_VERSION,
  EXPECTED_LANGUAGE_CODE,
  EXPECTED_ST96_VERSION,
  KOHO_NAMESPACES,
  ROOT_DEFINITIONS,
  type KohoRootDefinition,
} from "./constants";
import { extractAmendment, extractFullPublication } from "./extract";
import {
  inspectKohoEntryPath,
  resolveSchemaLocationToken,
  type KohoEntryPathInfo,
} from "./path";
import type {
  KohoAmendmentDocument,
  KohoDocumentKind,
  KohoEntryType,
  KohoFailedResult,
  KohoFullPublicationDocument,
  KohoIssueCode,
  KohoParseIssue,
  KohoUnconfirmedResult,
  KohoUnsupportedResult,
  KohoXmlParseInput,
  KohoXmlParseResult,
  KohoXmlSourceMetadata,
} from "./types";
import {
  attributeValue,
  childrenNamed,
  directPath,
  hasValidLimits,
  parseXmlTree,
  rawTextContent,
  type XmlTreeElement,
} from "./xml-tree";

const FULL_PUBLICATION_KINDS = new Set<KohoDocumentKind>([
  "A1",
  "P1",
  "B1",
  "B2",
]);
const AMENDMENT_KINDS = new Set<KohoDocumentKind>(["A5", "P5"]);

const IDENTITY_ISSUE_CODES = new Set<KohoIssueCode>([
  "root_path_mismatch",
  "package_type_mismatch",
  "kind_mismatch",
  "index_hint_missing",
  "schema_mismatch",
  "version_mismatch",
  "publication_number_mismatch",
  "publication_date_mismatch",
]);

const IDENTITY_CARDINALITY_FIELDS = new Set([
  "bibliographicData",
  "publicationIdentification",
  "publicationNumber",
  "publicationDate",
  "applicationIdentification",
  "applicationNumber",
  "applicationDate",
  "plainLanguageDesignationText",
  "amendmentHeader",
]);

const IDENTITY_SCALAR_STRUCTURE_FIELDS = new Set([
  "publicationNumber",
  "publicationDate",
  "applicationNumber",
  "applicationDate",
  "plainLanguageDesignationText",
  "correctedPublicationCategory",
]);

function isFullPublicationKind(
  kind: KohoDocumentKind,
): kind is KohoFullPublicationDocument["kind"] {
  return FULL_PUBLICATION_KINDS.has(kind);
}

function isAmendmentKind(
  kind: KohoDocumentKind,
): kind is KohoAmendmentDocument["kind"] {
  return AMENDMENT_KINDS.has(kind);
}

function initialSource(input: KohoXmlParseInput): KohoXmlSourceMetadata {
  return {
    sourceEntryPath: input.entryPath,
    normalizedEntryPath: input.entryPath.replace(/\\/g, "/"),
    xmlByteLength: null,
    rootLocalName: null,
    rootNamespaceUri: null,
    schemaBasename: null,
    st96Version: null,
    ipoVersion: null,
    languageCode: null,
    xsdValidation: "not_performed",
  };
}

function issue(
  code: KohoIssueCode,
  status: KohoParseIssue["status"],
  message: string,
  field?: string,
): KohoParseIssue {
  return { code, status, message, ...(field ? { field } : {}) };
}

function failedResult(
  source: KohoXmlSourceMetadata,
  issues: KohoParseIssue[],
  entryType: KohoEntryType = "unknown",
  kind: KohoDocumentKind | null = null,
): KohoFailedResult {
  return { status: "failed", entryType, kind, source, issues };
}

function unsupportedResult(
  source: KohoXmlSourceMetadata,
  issues: KohoParseIssue[],
): KohoUnsupportedResult {
  return {
    status: "unsupported_type",
    entryType: "unknown",
    kind: null,
    source,
    issues,
  };
}

function unconfirmedResult(
  source: KohoXmlSourceMetadata,
  issues: KohoParseIssue[],
  kind: KohoDocumentKind | null = null,
): KohoUnconfirmedResult {
  return {
    status: "review_required",
    entryType: "unknown",
    kind,
    source,
    issues,
  };
}

function parserFailureIssue(code: KohoIssueCode): KohoParseIssue {
  const messages: Partial<Record<KohoIssueCode, string>> = {
    xml_byte_limit_exceeded: "The XML byte limit was exceeded.",
    xml_depth_limit_exceeded: "The XML element depth limit was exceeded.",
    xml_element_limit_exceeded: "The XML element count limit was exceeded.",
    xml_text_limit_exceeded: "The decoded XML text limit was exceeded.",
    doctype_forbidden: "DOCTYPE declarations are not accepted by this parser.",
    malformed_xml: "The XML is not well formed.",
    invalid_utf8: "The XML input is not valid UTF-8 text.",
    unknown_named_entity: "The XML contains an unsupported named entity.",
  };
  return issue(
    code,
    "failed",
    messages[code] ?? "The XML entry could not be parsed safely.",
    "xml",
  );
}

interface SchemaLocationInfo {
  locationToken: string | null;
  allLocationTokens: string[];
  basename: string | null;
  malformed: boolean;
}

function schemaLocationInfo(root: XmlTreeElement): SchemaLocationInfo {
  const value = attributeValue(
    root,
    KOHO_NAMESPACES.xsi,
    "schemaLocation",
  );
  if (!value) {
    return {
      locationToken: null,
      allLocationTokens: [],
      basename: null,
      malformed: true,
    };
  }

  const tokens = value.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length % 2 !== 0) {
    return {
      locationToken: null,
      allLocationTokens: [],
      basename: null,
      malformed: true,
    };
  }
  const matches: string[] = [];
  const allLocationTokens: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    allLocationTokens.push(tokens[index + 1]);
    if (tokens[index] === KOHO_NAMESPACES.jpPatent) {
      matches.push(tokens[index + 1]);
    }
  }
  if (matches.length !== 1) {
    return {
      locationToken: null,
      allLocationTokens,
      basename: null,
      malformed: true,
    };
  }
  const locationToken = matches[0];
  return {
    locationToken,
    allLocationTokens,
    basename: locationToken.split(/[\\/]/).at(-1) ?? null,
    malformed: false,
  };
}

function sourceWithRoot(
  source: KohoXmlSourceMetadata,
  root: XmlTreeElement,
  xmlByteLength: number,
): KohoXmlSourceMetadata {
  const schema = schemaLocationInfo(root);
  return {
    ...source,
    xmlByteLength,
    rootLocalName: root.localName,
    rootNamespaceUri: root.namespaceUri,
    schemaBasename: schema.basename,
    st96Version: attributeValue(
      root,
      KOHO_NAMESPACES.common,
      "st96Version",
    ),
    ipoVersion: attributeValue(
      root,
      KOHO_NAMESPACES.common,
      "ipoVersion",
    ),
    languageCode: attributeValue(
      root,
      KOHO_NAMESPACES.common,
      "languageCode",
    ),
  };
}

function addIdentityChecks(
  input: KohoXmlParseInput,
  path: KohoEntryPathInfo,
  root: XmlTreeElement,
  rootDefinition: KohoRootDefinition,
  kind: KohoDocumentKind,
  source: KohoXmlSourceMetadata,
  issues: KohoParseIssue[],
): void {
  if (!path.isPrimaryXml || path.section !== rootDefinition.section) {
    issues.push(
      issue(
        "root_path_mismatch",
        "review_required",
        "The XML root and entry path do not identify the same entry type.",
        "entryPath",
      ),
    );
  }

  if (input.packageType !== rootDefinition.packageType) {
    issues.push(
      issue(
        "package_type_mismatch",
        "review_required",
        "The package type and XML root do not match.",
        "packageType",
      ),
    );
  }

  const expectedIndexKind =
    rootDefinition.expectedIndexKind ?? (kind === "B1" ? "B1" : "B2");
  if (!input.indexHint?.kindCode) {
    issues.push(
      issue(
        "index_hint_missing",
        "review_required",
        "The index kind hint is unavailable for the required cross-check.",
        "indexHint.kindCode",
      ),
    );
  } else if (input.indexHint.kindCode !== expectedIndexKind) {
    issues.push(
      issue(
        "kind_mismatch",
        "review_required",
        "The index kind hint conflicts with the XML kind evidence.",
        "indexHint.kindCode",
      ),
    );
  }

  if (!input.indexHint?.publicationNumber) {
    issues.push(
      issue(
        "index_hint_missing",
        "review_required",
        "The index publication number is unavailable for the required cross-check.",
        "indexHint.publicationNumber",
      ),
    );
  }

  const schema = schemaLocationInfo(root);
  const resolvedSchema = schema.locationToken
    ? resolveSchemaLocationToken(
        path.normalizedPath,
        schema.locationToken,
        rootDefinition.schemaBasename,
      )
    : null;
  const everySchemaLocationIsSafe = schema.allLocationTokens.every(
    (locationToken) => {
      const basename = locationToken.split(/[\\/]/).at(-1) ?? "";
      const resolved = resolveSchemaLocationToken(
        path.normalizedPath,
        locationToken,
        basename,
      );
      return resolved.ok && resolved.isXsdRootFile;
    },
  );
  if (
    schema.malformed ||
    !everySchemaLocationIsSafe ||
    !resolvedSchema?.ok ||
    !resolvedSchema.matchesExpectedXsdPath ||
    source.schemaBasename !== rootDefinition.schemaBasename
  ) {
    issues.push(
      issue(
        "schema_mismatch",
        "review_required",
        "The schema reference does not match the expected local schema path.",
        "xsi:schemaLocation",
      ),
    );
  }

  if (
    source.st96Version !== EXPECTED_ST96_VERSION ||
    source.ipoVersion !== EXPECTED_IPO_VERSION ||
    source.languageCode !== EXPECTED_LANGUAGE_CODE
  ) {
    issues.push(
      issue(
        "version_mismatch",
        "review_required",
        "The XML version or language metadata does not match the supported profile.",
        "rootMetadata",
      ),
    );
  }
}

function normalizePublicationNumber(
  value: string,
  kind: KohoDocumentKind,
): string {
  const compact = value
    .normalize("NFC")
    .toUpperCase()
    .replace(/[\s\-‐‑‒–—―]/g, "");
  if ((kind === "B1" || kind === "B2") && /^\d+$/.test(compact)) {
    return compact.replace(/^0+(?=\d)/, "");
  }
  return compact;
}

function hasExpectedPublicationNumberFormat(
  value: string,
  kind: KohoDocumentKind,
): boolean {
  const normalized = value.trim().normalize("NFC");
  if (kind === "A1" || kind === "A5") {
    return /^\d{10}$/.test(normalized);
  }
  if (kind === "P1" || kind === "P5") {
    return /^WO\d{10}$/.test(normalized);
  }
  return /^\d+$/.test(normalized);
}

function addDocumentIdentityChecks(
  input: KohoXmlParseInput,
  path: KohoEntryPathInfo,
  kind: KohoDocumentKind,
  publicationNumber: string,
  publicationDate: string,
  issues: KohoParseIssue[],
): void {
  const documentKey = normalizePublicationNumber(publicationNumber, kind);
  const formatChecks: Array<[value: string | null | undefined, field: string]> = [
    [publicationNumber, "publicationNumber"],
    [path.documentNumber, "entryPath"],
    [input.indexHint?.publicationNumber, "indexHint.publicationNumber"],
  ];
  for (const [value, field] of formatChecks) {
    if (value === null || value === undefined) {
      continue;
    }
    if (hasExpectedPublicationNumberFormat(value, kind)) {
      continue;
    }
    issues.push(
      issue(
        "publication_number_mismatch",
        "review_required",
        "A publication number does not match the expected kind format.",
        field,
      ),
    );
  }
  if (
    path.documentNumber &&
    normalizePublicationNumber(path.documentNumber, kind) !== documentKey
  ) {
    issues.push(
      issue(
        "publication_number_mismatch",
        "review_required",
        "The XML publication number conflicts with the entry folder.",
        "publicationNumber",
      ),
    );
  }
  if (
    input.indexHint?.publicationNumber &&
    normalizePublicationNumber(input.indexHint.publicationNumber, kind) !==
      documentKey
  ) {
    issues.push(
      issue(
        "publication_number_mismatch",
        "review_required",
        "The XML publication number conflicts with the index hint.",
        "indexHint.publicationNumber",
      ),
    );
  }

  if (input.indexHint?.publicationDate) {
    const hintDate = input.indexHint.publicationDate.trim();
    const xmlDate = publicationDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(hintDate) || hintDate !== xmlDate) {
      issues.push(
        issue(
          "publication_date_mismatch",
          "review_required",
          "The XML publication date conflicts with the index hint.",
          "indexHint.publicationDate",
        ),
      );
    }
  }
}

function registeredKind(
  root: XmlTreeElement,
  rootDefinition: KohoRootDefinition,
  input: KohoXmlParseInput,
  issues: KohoParseIssue[],
): "B1" | "B2" | null {
  const bibliographicData = rootDefinition.bibliographicLocalName
    ? directPath(root, [
        [KOHO_NAMESPACES.jpPatent, rootDefinition.bibliographicLocalName],
      ])
    : null;
  const designations = childrenNamed(
    bibliographicData,
    KOHO_NAMESPACES.patent,
    "PlainLanguageDesignationText",
  );
  if (designations.length > 1) {
    issues.push(
      issue(
        "cardinality_mismatch",
        "review_required",
        "The registered-publication kind display occurs more than once.",
        "plainLanguageDesignationText",
      ),
    );
  }
  const designation = designations[0] ?? null;
  const display = designation
    ? rawTextContent(designation).trim().normalize("NFC")
    : "";
  const displayKind =
    display === "特許公報(B1)"
      ? "B1"
      : display === "特許公報(B2)"
        ? "B2"
        : null;

  if (displayKind) {
    return displayKind;
  }

  const hintKind =
    input.indexHint?.kindCode === "B1" || input.indexHint?.kindCode === "B2"
      ? input.indexHint.kindCode
      : null;
  if (hintKind) {
    issues.push(
      issue(
        "kind_mismatch",
        "review_required",
        "The registered-publication kind display is missing or unknown.",
        designation?.sourcePath ?? "plainLanguageDesignationText",
      ),
    );
    return hintKind;
  }

  issues.push(
    issue(
      "kind_mismatch",
      "unsupported_type",
      "The registered-publication kind cannot be identified safely.",
      designation?.sourcePath ?? "plainLanguageDesignationText",
    ),
  );
  return null;
}

function hasIdentityIssue(issues: KohoParseIssue[]): boolean {
  return issues.some(
    (item) =>
      IDENTITY_ISSUE_CODES.has(item.code) ||
      (item.code === "cardinality_mismatch" &&
        IDENTITY_CARDINALITY_FIELDS.has(item.field ?? "")) ||
      (item.code === "unknown_inline_element" &&
        IDENTITY_SCALAR_STRUCTURE_FIELDS.has(item.field ?? "")),
  );
}

function hasReviewIssue(issues: KohoParseIssue[]): boolean {
  return issues.some((item) => item.status === "review_required");
}

export function parseKohoXml(input: KohoXmlParseInput): KohoXmlParseResult {
  let source = initialSource(input);

  if (!hasValidLimits(input.limits)) {
    return failedResult(source, [
      issue(
        "invalid_limits",
        "failed",
        "Every XML resource limit must be a positive safe integer.",
        "limits",
      ),
    ]);
  }

  const path = inspectKohoEntryPath(input.entryPath);
  if (!path.ok) {
    return failedResult(source, [
      issue(
        "unsafe_entry_path",
        "failed",
        "The entry path is not a safe relative ZIP path.",
        "entryPath",
      ),
    ]);
  }
  source = { ...source, normalizedEntryPath: path.normalizedPath };

  const parsed = parseXmlTree(input.xml, input.limits);
  if (!parsed.ok) {
    source = { ...source, xmlByteLength: parsed.xmlByteLength };
    return failedResult(source, [parserFailureIssue(parsed.code)]);
  }

  source = sourceWithRoot(source, parsed.root, parsed.xmlByteLength);
  const root = parsed.root;

  if (
    parsed.doctype === "st26_v1_3" &&
    !(
      root.localName === "ST26SequenceListing" &&
      root.namespaceUri === "" &&
      path.isDeeperXml
    )
  ) {
    return failedResult(source, [parserFailureIssue("doctype_forbidden")]);
  }

  if (root.localName === "ST26SequenceListing") {
    if (root.namespaceUri !== "") {
      return unsupportedResult(source, [
        issue(
          "unknown_namespace",
          "unsupported_type",
          "The sequence-listing namespace is not supported.",
          "root",
        ),
      ]);
    }
    if (!path.isDeeperXml) {
      return unconfirmedResult(source, [
        issue(
          "root_path_mismatch",
          "review_required",
          "The sequence-listing root is not located at a nested XML path.",
          "entryPath",
        ),
      ]);
    }
    const dtdVersion = attributeValue(root, "", "dtdVersion");
    const st26Issues: KohoParseIssue[] =
      dtdVersion === "V1_3"
        ? []
        : [
            issue(
              "version_mismatch",
              "review_required",
              "The sequence-listing DTD version is missing or unsupported.",
              "dtdVersion",
            ),
          ];
    const expectedPackageType = path.section === "P_B1" ? "JPB" : "JPA";
    if (input.packageType !== expectedPackageType) {
      st26Issues.push(
        issue(
          "package_type_mismatch",
          "review_required",
          "The package type conflicts with the nested XML section.",
          "packageType",
        ),
      );
    }
    if (st26Issues.length === 0) {
      return {
        status: "success",
        entryType: "nested_st26",
        kind: null,
        identityConfirmed: true,
        source,
        issues: [],
        nestedSt26: {
          dtdVersion,
          contentParsed: false,
        },
      };
    }
    return {
      status: "review_required",
      entryType: "nested_st26",
      kind: null,
      identityConfirmed: false,
      source,
      issues: st26Issues,
      nestedSt26: {
        dtdVersion,
        contentParsed: false,
      },
    };
  }

  if (root.namespaceUri !== KOHO_NAMESPACES.jpPatent) {
    return unsupportedResult(source, [
      issue(
        "unknown_namespace",
        "unsupported_type",
        "The XML root namespace is not supported.",
        "root",
      ),
    ]);
  }

  const rootDefinition = Object.hasOwn(ROOT_DEFINITIONS, root.localName)
    ? ROOT_DEFINITIONS[root.localName]
    : undefined;
  if (!rootDefinition) {
    return unsupportedResult(source, [
      issue(
        "unknown_root",
        "unsupported_type",
        "The XML root type is not supported.",
        "root",
      ),
    ]);
  }

  const issues: KohoParseIssue[] = [];
  const kind =
    rootDefinition.fixedKind ??
    registeredKind(root, rootDefinition, input, issues);
  if (!kind) {
    return unsupportedResult(source, issues);
  }

  addIdentityChecks(
    input,
    path,
    root,
    rootDefinition,
    kind,
    source,
    issues,
  );

  if (rootDefinition.entryType === "full_publication") {
    if (!isFullPublicationKind(kind)) {
      return unconfirmedResult(source, [
        ...issues,
        issue(
          "kind_mismatch",
          "review_required",
          "The identified kind is not a full-publication kind.",
          "kind",
        ),
      ], kind);
    }
    const document = extractFullPublication(
      root,
      kind,
      rootDefinition,
      source,
      issues,
    );
    if (!document) {
      return failedResult(source, issues, "full_publication", kind);
    }
    addDocumentIdentityChecks(
      input,
      path,
      kind,
      document.publicationNumber.value,
      document.publicationDate.value,
      issues,
    );
    const identityConfirmed = !hasIdentityIssue(issues);
    if (identityConfirmed) {
      return {
        status: hasReviewIssue(issues) ? "review_required" : "success",
        entryType: "full_publication",
        kind,
        identityConfirmed: true,
        document,
        candidate: null,
        source,
        issues,
      };
    }
    return {
      status: "review_required",
      entryType: "full_publication",
      kind,
      identityConfirmed: false,
      document: null,
      candidate: document,
      source,
      issues,
    };
  }

  if (!isAmendmentKind(kind)) {
    return unconfirmedResult(source, [
      ...issues,
      issue(
        "kind_mismatch",
        "review_required",
        "The identified kind is not an amendment kind.",
        "kind",
      ),
    ], kind);
  }
  const amendment = extractAmendment(
    root,
    kind,
    rootDefinition,
    source,
    issues,
  );
  if (!amendment) {
    return failedResult(source, issues, "amendment", kind);
  }
  addDocumentIdentityChecks(
    input,
    path,
    kind,
    amendment.publicationNumber.value,
    amendment.publicationDate.value,
    issues,
  );
  const identityConfirmed = !hasIdentityIssue(issues);
  if (identityConfirmed) {
    return {
      status: hasReviewIssue(issues) ? "review_required" : "success",
      entryType: "amendment",
      kind,
      identityConfirmed: true,
      amendment,
      candidate: null,
      source,
      issues,
    };
  }
  return {
    status: "review_required",
    entryType: "amendment",
    kind,
    identityConfirmed: false,
    amendment: null,
    candidate: amendment,
    source,
    issues,
  };
}
