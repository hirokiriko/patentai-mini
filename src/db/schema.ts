import {
  boolean,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const cases = pgTable("cases", {
  caseId: serial("case_id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  baseApplicationMode: boolean("base_application_mode").notNull().default(false),
  baseApplicationNumber: text("base_application_number"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const draftPatents = pgTable("draft_patents", {
  draftId: serial("draft_id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => cases.caseId),
  kind: text("kind").notNull().default("main"),
  sourceFilePath: text("source_file_path"),
  parsedText: text("parsed_text"),
  extractedClaimsJson: text("extracted_claims_json"),
});

export const searchQuerySets = pgTable("search_query_sets", {
  querySetId: serial("query_set_id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => cases.caseId),
  broadQuery: text("broad_query"),
  balancedQuery: text("balanced_query"),
  narrowQuery: text("narrow_query"),
  rationaleJson: text("rationale_json"),
});

export const priorArtDocuments = pgTable("prior_art_documents", {
  docId: serial("doc_id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => cases.caseId),
  publicationNo: text("publication_no"),
  title: text("title"),
  abstract: text("abstract"),
  claimsText: text("claims_text"),
  sourceCsvRowJson: text("source_csv_row_json"),
  normalizedElementsJson: text("normalized_elements_json"),
});

export const comparisonResults = pgTable("comparison_results", {
  resultId: serial("result_id").primaryKey(),
  caseId: integer("case_id")
    .notNull()
    .references(() => cases.caseId),
  draftClaimId: text("draft_claim_id"),
  priorDocId: integer("prior_doc_id").references(
    () => priorArtDocuments.docId
  ),
  lexicalScore: real("lexical_score"),
  semanticScore: real("semantic_score"),
  structuralScore: real("structural_score"),
  matchedElementsJson: text("matched_elements_json"),
  riskLabel: text("risk_label"),
});

export const kohoImportRuns = pgTable(
  "koho_import_runs",
  {
    importId: serial("import_id").primaryKey(),
    packageType: text("package_type").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    packageStatus: text("package_status").notNull(),
    documentCount: integer("document_count").notNull(),
    amendmentCount: integer("amendment_count").notNull(),
    nestedSt26Count: integer("nested_st26_count").notNull(),
    countsJson: text("counts_json").notNull(),
    issuesJson: text("issues_json").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("koho_import_runs_package_type_source_sha256_unique").on(
      table.packageType,
      table.sourceSha256,
    ),
  ],
);

export const kohoImportDocuments = pgTable(
  "koho_import_documents",
  {
    documentId: serial("document_id").primaryKey(),
    importId: integer("import_id")
      .notNull()
      .references(() => kohoImportRuns.importId, { onDelete: "cascade" }),
    normalizedEntryPath: text("normalized_entry_path").notNull(),
    parseStatus: text("parse_status").notNull(),
    kind: text("kind").notNull(),
    publicationNumber: text("publication_number").notNull(),
    applicationNumber: text("application_number").notNull(),
    publicationDate: text("publication_date").notNull(),
    registrationNumber: text("registration_number"),
    registrationDate: text("registration_date"),
    inventionTitle: text("invention_title").notNull(),
    abstractText: text("abstract_text"),
    claimsText: text("claims_text").notNull(),
    applicantsJson: text("applicants_json").notNull(),
    ipcJson: text("ipc_json").notNull(),
    fiJson: text("fi_json").notNull(),
    parseIssuesJson: text("parse_issues_json").notNull(),
    sourceMetadataJson: text("source_metadata_json").notNull(),
    contentSha256: text("content_sha256").notNull(),
  },
  (table) => [
    uniqueIndex(
      "koho_import_documents_import_id_normalized_entry_path_unique",
    ).on(table.importId, table.normalizedEntryPath),
  ],
);
