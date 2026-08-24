import type { KohoDocumentKind, KohoPackageType } from "./types";

export const KOHO_NAMESPACES = {
  jpPatent: "http://www.jpo.go.jp/standards/XMLSchema/ST96/JPPatent",
  jpCommon: "http://www.jpo.go.jp/standards/XMLSchema/ST96/JPCommon",
  patent: "http://www.wipo.int/standards/XMLSchema/ST96/Patent",
  common: "http://www.wipo.int/standards/XMLSchema/ST96/Common",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
} as const;

export interface KohoRootDefinition {
  entryType: "full_publication" | "amendment";
  fixedKind: KohoDocumentKind | null;
  packageType: KohoPackageType;
  section: "P_A1" | "P_A5" | "P_P1" | "P_P5" | "P_B1";
  expectedIndexKind: "A" | "A5" | "B1" | "B2" | null;
  schemaBasename: string;
  bibliographicLocalName?: string;
  partyBagLocalName?: string;
  amendmentHeaderLocalName?: string;
}

export const ROOT_DEFINITIONS: Record<string, KohoRootDefinition> = {
  UnexaminedPatentPublication: {
    entryType: "full_publication",
    fixedKind: "A1",
    packageType: "JPA",
    section: "P_A1",
    expectedIndexKind: "A",
    schemaBasename: "JPUnexaminedPatentPublication_V1_0.xsd",
    bibliographicLocalName:
      "UnexaminedPatentPublicationBibliographicData",
    partyBagLocalName: "UnexaminedPatentPublicationPartyBag",
  },
  UnexaminedPatentPublicationAmendment: {
    entryType: "amendment",
    fixedKind: "A5",
    packageType: "JPA",
    section: "P_A5",
    expectedIndexKind: "A5",
    schemaBasename: "JPUnexaminedPatentPublicationAmendment_V1_0.xsd",
    amendmentHeaderLocalName:
      "UnexaminedPatentPublicationAmendmentHeader",
  },
  InternationalPatentPublication: {
    entryType: "full_publication",
    fixedKind: "P1",
    packageType: "JPA",
    section: "P_P1",
    expectedIndexKind: "A",
    schemaBasename: "JPInternationalPatentPublication_V1_0.xsd",
    bibliographicLocalName:
      "InternationalPatentPublicationBibliographicData",
    partyBagLocalName: "InternationalPatentPublicationPartyBag",
  },
  InternationalPatentPublicationAmendment: {
    entryType: "amendment",
    fixedKind: "P5",
    packageType: "JPA",
    section: "P_P5",
    expectedIndexKind: "A5",
    schemaBasename: "JPInternationalPatentPublicationAmendment_V1_0.xsd",
    amendmentHeaderLocalName:
      "InternationalPatentPublicationAmendmentHeader",
  },
  RegisteredPatentPublication: {
    entryType: "full_publication",
    fixedKind: null,
    packageType: "JPB",
    section: "P_B1",
    expectedIndexKind: null,
    schemaBasename: "JPRegisteredPatentPublication_V1_0.xsd",
    bibliographicLocalName: "RegisteredPatentPublicationBibliographicData",
    partyBagLocalName: "RegisteredPatentPublicationPartyBag",
  },
};

export const EXPECTED_ST96_VERSION = "V3_1";
export const EXPECTED_IPO_VERSION = "JP_V1_0";
export const EXPECTED_LANGUAGE_CODE = "ja";
