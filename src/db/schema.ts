import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const cases = sqliteTable("cases", {
  caseId: integer("case_id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  baseApplicationMode: integer("base_application_mode", { mode: "boolean" })
    .notNull()
    .default(false),
  baseApplicationNumber: text("base_application_number"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const draftPatents = sqliteTable("draft_patents", {
  draftId: integer("draft_id").primaryKey({ autoIncrement: true }),
  caseId: integer("case_id")
    .notNull()
    .references(() => cases.caseId),
  kind: text("kind").notNull().default("main"),
  sourceFilePath: text("source_file_path"),
  parsedText: text("parsed_text"),
  extractedClaimsJson: text("extracted_claims_json"),
});

export const searchQuerySets = sqliteTable("search_query_sets", {
  querySetId: integer("query_set_id").primaryKey({ autoIncrement: true }),
  caseId: integer("case_id")
    .notNull()
    .references(() => cases.caseId),
  broadQuery: text("broad_query"),
  balancedQuery: text("balanced_query"),
  narrowQuery: text("narrow_query"),
  rationaleJson: text("rationale_json"),
});

export const priorArtDocuments = sqliteTable("prior_art_documents", {
  docId: integer("doc_id").primaryKey({ autoIncrement: true }),
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

export const comparisonResults = sqliteTable("comparison_results", {
  resultId: integer("result_id").primaryKey({ autoIncrement: true }),
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
