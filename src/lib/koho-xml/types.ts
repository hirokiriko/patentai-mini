export type KohoPackageType = "JPA" | "JPB";

export type KohoDocumentKind = "A1" | "A5" | "P1" | "P5" | "B1" | "B2";

export type KohoIngestStatus =
  | "success"
  | "review_required"
  | "unsupported_type"
  | "failed";

export type KohoEntryType =
  | "full_publication"
  | "amendment"
  | "nested_st26"
  | "unknown";

export interface KohoXmlParseInput {
  packageType: KohoPackageType;
  entryPath: string;
  xml: string | Uint8Array;
  indexHint?: {
    kindCode?: string;
    publicationNumber?: string;
    publicationDate?: string;
  };
  limits: {
    maxXmlBytes: number;
    maxDepth: number;
    maxElements: number;
    maxTextBytes: number;
  };
}

export type KohoIssueCode =
  | "invalid_limits"
  | "unsafe_entry_path"
  | "xml_byte_limit_exceeded"
  | "xml_depth_limit_exceeded"
  | "xml_element_limit_exceeded"
  | "xml_text_limit_exceeded"
  | "doctype_forbidden"
  | "malformed_xml"
  | "invalid_utf8"
  | "unknown_named_entity"
  | "unknown_root"
  | "unknown_namespace"
  | "root_path_mismatch"
  | "package_type_mismatch"
  | "kind_mismatch"
  | "index_hint_missing"
  | "schema_mismatch"
  | "version_mismatch"
  | "publication_number_mismatch"
  | "publication_date_mismatch"
  | "cardinality_mismatch"
  | "required_field_missing"
  | "invalid_date"
  | "claims_missing"
  | "applicant_name_missing"
  | "optional_classification_missing"
  | "optional_abstract_missing"
  | "unsafe_reference_target"
  | "unknown_inline_element";

export interface KohoParseIssue {
  code: KohoIssueCode;
  status: Exclude<KohoIngestStatus, "success">;
  message: string;
  field?: string;
}

export interface KohoXmlSourceMetadata {
  sourceEntryPath: string;
  normalizedEntryPath: string;
  xmlByteLength: number | null;
  rootLocalName: string | null;
  rootNamespaceUri: string | null;
  schemaBasename: string | null;
  st96Version: string | null;
  ipoVersion: string | null;
  languageCode: string | null;
  xsdValidation: "not_performed";
}

export interface KohoSourceString {
  sourceValue: string;
  value: string;
  sourceElement?: KohoXmlElementSnapshot;
}

export type KohoDateValue = KohoSourceString;

export interface KohoReference {
  sourcePath: string;
  sourceTarget: string | null;
  sourceTargets: string[];
  unmodeledScalarPaths: string[];
  normalizedTarget: string | null;
  resolution: "not_inspected" | "rejected";
  preservedText: string;
  attributes: Record<string, string>;
  metadata: {
    imageFormatCategory: KohoSourceString | null;
    heightMeasure: KohoMeasure | null;
    widthMeasure: KohoMeasure | null;
    imageContentCategory: string | null;
  };
  source: KohoXmlElementSnapshot;
}

export interface KohoMeasure extends KohoSourceString {
  measureUnitCode: string | null;
}

export type KohoCollectedReferenceKind =
  | "inline_image"
  | "table_image"
  | "math_image"
  | "chemical_formula_image"
  | "drawing"
  | "chosen_drawing"
  | "search_report_page"
  | "reference_file"
  | "foreign_language_document"
  | "other_image";

export interface KohoCollectedReference {
  ordinal: number;
  kind: KohoCollectedReferenceKind;
  sourceEntryPath: string;
  reference: KohoReference;
}

export type KohoContentToken =
  | { type: "text"; text: string }
  | {
      type: "boundary";
      boundary: "line_break" | "paragraph" | "claim";
    }
  | { type: "figure_reference"; reference: KohoReference; text: string }
  | {
      type: "patent_citation";
      namespaceUri: string;
      content: KohoContentToken[];
      plainText: string;
      attributes: Record<string, string>;
      source: KohoXmlElementSnapshot;
    }
  | { type: "image_reference"; reference: KohoReference }
  | { type: "table_reference"; reference: KohoReference }
  | { type: "math_reference"; reference: KohoReference }
  | { type: "chemical_formula_reference"; reference: KohoReference }
  | {
      type: "subscript" | "superscript";
      content: KohoContentToken[];
      plainText: string | null;
    }
  | {
      type: "unknown_inline_element";
      namespaceUri: string;
      localName: string;
      content: KohoContentToken[];
      plainText: string | null;
    };

export interface KohoStructuredContent {
  tokens: KohoContentToken[];
  plainText: string;
}

export interface KohoApplicantName extends KohoSourceString {
  originalLanguageIndicator: boolean | null;
}

export interface KohoApplicant {
  ordinal: number;
  sequenceNumber: string | null;
  partyIdentifier: KohoSourceString | null;
  partyIdentifiers: KohoSourceString[];
  names: KohoApplicantName[];
}

export interface KohoClassification {
  ordinal: number;
  role: "main" | "further";
  sourceValue: string;
  sourceValues: string[];
  value: string;
  values: string[];
  sources: KohoSourceString[];
  attributes: {
    container: Readonly<Record<string, string>>;
    classification: Record<string, string>;
    value: Record<string, string>;
  };
}

export interface KohoClaim {
  ordinal: number;
  claimNumber: string | null;
  claimNumberSource: KohoSourceString | null;
  content: KohoStructuredContent;
  plainText: string;
}

export interface KohoDescriptionParagraph {
  ordinal: number;
  paragraphNumber: string | null;
  content: KohoStructuredContent;
  plainText: string;
}

export interface KohoFullPublicationDocument {
  kind: Extract<KohoDocumentKind, "A1" | "P1" | "B1" | "B2">;
  publicationNumber: KohoSourceString;
  registrationNumber: KohoSourceString | null;
  applicationNumber: KohoSourceString;
  applicationDate: KohoDateValue;
  publicationDate: KohoDateValue;
  registrationDate: KohoDateValue | null;
  plainLanguageDesignation: KohoSourceString | null;
  applicants: KohoApplicant[];
  inventionTitle: KohoStructuredContent;
  ipc: KohoClassification[];
  fi: KohoClassification[];
  abstract: KohoStructuredContent | null;
  claims: KohoClaim[];
  description: KohoDescriptionParagraph[];
  amendmentContent: KohoXmlElementSnapshot[];
  references: KohoCollectedReference[];
  source: KohoXmlSourceMetadata;
}

export interface KohoXmlSnapshotAttribute {
  namespaceUri: string;
  localName: string;
  sourceName: string;
  value: string;
}

export type KohoXmlSnapshotChild =
  | { type: "text"; value: string }
  | { type: "element"; element: KohoXmlElementSnapshot };

export interface KohoXmlElementSnapshot {
  namespaceUri: string;
  localName: string;
  sourceName: string;
  attributes: KohoXmlSnapshotAttribute[];
  children: KohoXmlSnapshotChild[];
}

export interface KohoAmendmentDocument {
  kind: Extract<KohoDocumentKind, "A5" | "P5">;
  publicationNumber: KohoSourceString;
  applicationNumber: KohoSourceString;
  publicationDate: KohoDateValue;
  applicationDate: KohoDateValue | null;
  correctedPublicationCategory: KohoSourceString;
  ipc: KohoClassification[];
  fi: KohoClassification[];
  writtenAmendmentFilingDates: KohoDateValue[];
  amendedClaims: KohoClaim[];
  nationalPublicationNumber: KohoSourceString | null;
  previousPublicationDate: KohoDateValue | null;
  annualNumber: KohoSourceString | null;
  contentExtraction: "structured_snapshot";
  amendmentContent: KohoXmlElementSnapshot;
  references: KohoCollectedReference[];
  source: KohoXmlSourceMetadata;
}

export interface KohoNestedSt26Metadata {
  dtdVersion: string | null;
  contentParsed: false;
}

interface KohoResultBase {
  status: KohoIngestStatus;
  entryType: KohoEntryType;
  kind: KohoDocumentKind | null;
  source: KohoXmlSourceMetadata;
  issues: KohoParseIssue[];
}

interface KohoFullPublicationResultBase extends KohoResultBase {
  status: "success" | "review_required";
  entryType: "full_publication";
  kind: Extract<KohoDocumentKind, "A1" | "P1" | "B1" | "B2">;
}

export type KohoFullPublicationResult =
  | (KohoFullPublicationResultBase & {
      identityConfirmed: true;
      document: KohoFullPublicationDocument;
      candidate: null;
    })
  | (KohoFullPublicationResultBase & {
      status: "review_required";
      identityConfirmed: false;
      document: null;
      candidate: KohoFullPublicationDocument;
    });

interface KohoAmendmentResultBase extends KohoResultBase {
  status: "success" | "review_required";
  entryType: "amendment";
  kind: Extract<KohoDocumentKind, "A5" | "P5">;
}

export type KohoAmendmentResult =
  | (KohoAmendmentResultBase & {
      identityConfirmed: true;
      amendment: KohoAmendmentDocument;
      candidate: null;
    })
  | (KohoAmendmentResultBase & {
      status: "review_required";
      identityConfirmed: false;
      amendment: null;
      candidate: KohoAmendmentDocument;
    });

interface KohoNestedSt26ResultBase extends KohoResultBase {
  status: "success" | "review_required";
  entryType: "nested_st26";
  kind: null;
  nestedSt26: KohoNestedSt26Metadata;
}

export type KohoNestedSt26Result =
  | (KohoNestedSt26ResultBase & {
      status: "success";
      identityConfirmed: true;
    })
  | (KohoNestedSt26ResultBase & {
      status: "review_required";
      identityConfirmed: false;
    });

export interface KohoUnsupportedResult extends KohoResultBase {
  status: "unsupported_type";
  entryType: "unknown";
  kind: null;
}

export interface KohoUnconfirmedResult extends KohoResultBase {
  status: "review_required";
  entryType: "unknown";
  kind: KohoDocumentKind | null;
}

export interface KohoFailedResult extends KohoResultBase {
  status: "failed";
}

export type KohoXmlParseResult =
  | KohoFullPublicationResult
  | KohoAmendmentResult
  | KohoNestedSt26Result
  | KohoUnsupportedResult
  | KohoUnconfirmedResult
  | KohoFailedResult;
