import {
  boolean,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
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
