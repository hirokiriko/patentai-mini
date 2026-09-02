import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

export const caseWatchSettings = pgTable(
  "case_watch_settings",
  {
    watchId: serial("watch_id").primaryKey(),
    caseId: integer("case_id")
      .notNull()
      .references(() => cases.caseId, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    monitoringFromDate: text("monitoring_from_date").notNull(),
    cursorRunUpdatedAt: timestamp("cursor_run_updated_at", {
      mode: "string",
      withTimezone: true,
    }),
    cursorImportId: integer("cursor_import_id"),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("case_watch_settings_case_id_unique").on(table.caseId),
    check(
      "case_watch_settings_cursor_pair_check",
      sql`(${table.cursorRunUpdatedAt} is null and ${table.cursorImportId} is null) or (${table.cursorRunUpdatedAt} is not null and ${table.cursorImportId} is not null and ${table.cursorImportId} > 0)`,
    ),
  ],
);

export const caseWatchRuns = pgTable(
  "case_watch_runs",
  {
    runId: serial("run_id").primaryKey(),
    watchId: integer("watch_id")
      .notNull()
      .references(() => caseWatchSettings.watchId, { onDelete: "cascade" }),
    status: text("status").notNull(),
    monitoringFromDate: text("monitoring_from_date").notNull(),
    baseCursorRunUpdatedAt: timestamp("base_cursor_run_updated_at", {
      mode: "string",
      withTimezone: true,
    }),
    baseCursorImportId: integer("base_cursor_import_id"),
    upperCursorRunUpdatedAt: timestamp("upper_cursor_run_updated_at", {
      mode: "string",
      withTimezone: true,
    }),
    upperCursorImportId: integer("upper_cursor_import_id"),
    startedAt: timestamp("started_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "string",
      withTimezone: true,
    }),
    scannedImportRunCount: integer("scanned_import_run_count")
      .notNull()
      .default(0),
    scannedDocumentCount: integer("scanned_document_count")
      .notNull()
      .default(0),
    prefilteredCount: integer("prefiltered_count").notNull().default(0),
    analyzedCount: integer("analyzed_count").notNull().default(0),
    newFindingCount: integer("new_finding_count").notNull().default(0),
    fallbackFindingCount: integer("fallback_finding_count")
      .notNull()
      .default(0),
    analysisMode: text("analysis_mode").notNull().default("none"),
    errorCode: text("error_code"),
  },
  (table) => [
    check(
      "case_watch_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "case_watch_runs_base_cursor_pair_check",
      sql`(${table.baseCursorRunUpdatedAt} is null and ${table.baseCursorImportId} is null) or (${table.baseCursorRunUpdatedAt} is not null and ${table.baseCursorImportId} is not null and ${table.baseCursorImportId} > 0)`,
    ),
    check(
      "case_watch_runs_upper_cursor_pair_check",
      sql`(${table.upperCursorRunUpdatedAt} is null and ${table.upperCursorImportId} is null) or (${table.upperCursorRunUpdatedAt} is not null and ${table.upperCursorImportId} is not null and ${table.upperCursorImportId} > 0)`,
    ),
    check(
      "case_watch_runs_counts_check",
      sql`${table.scannedImportRunCount} >= 0 and ${table.scannedDocumentCount} >= 0 and ${table.prefilteredCount} >= 0 and ${table.analyzedCount} >= 0 and ${table.newFindingCount} >= 0 and ${table.fallbackFindingCount} >= 0`,
    ),
    check(
      "case_watch_runs_analysis_mode_check",
      sql`${table.analysisMode} in ('none', 'ai', 'fallback')`,
    ),
  ],
);

export const caseWatchFindings = pgTable(
  "case_watch_findings",
  {
    findingId: serial("finding_id").primaryKey(),
    watchId: integer("watch_id")
      .notNull()
      .references(() => caseWatchSettings.watchId, { onDelete: "cascade" }),
    firstRunId: integer("first_run_id")
      .notNull()
      .references(() => caseWatchRuns.runId, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    corpusDocumentId: integer("corpus_document_id").references(
      () => kohoImportDocuments.documentId,
      { onDelete: "set null" },
    ),
    packageType: text("package_type").notNull(),
    kind: text("kind").notNull(),
    publicationNumber: text("publication_number").notNull(),
    publicationDate: text("publication_date").notNull(),
    inventionTitle: text("invention_title").notNull(),
    abstractPreview: text("abstract_preview"),
    lexicalScore: real("lexical_score").notNull(),
    elementScore: real("element_score").notNull(),
    semanticScore: real("semantic_score").notNull(),
    structuralScore: real("structural_score").notNull(),
    riskLabel: text("risk_label").notNull(),
    analysisJson: text("analysis_json").notNull(),
    analysisMode: text("analysis_mode").notNull(),
    reviewStatus: text("review_status").notNull().default("unreviewed"),
    firstSeenAt: timestamp("first_seen_at", {
      mode: "string",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("case_watch_findings_watch_id_source_key_unique").on(
      table.watchId,
      table.sourceKey,
    ),
    check(
      "case_watch_findings_source_key_check",
      sql`${table.sourceKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "case_watch_findings_score_check",
      sql`${table.lexicalScore} between 0 and 1 and ${table.elementScore} between 0 and 1 and ${table.semanticScore} between 0 and 1 and ${table.structuralScore} between 0 and 1`,
    ),
    check(
      "case_watch_findings_analysis_mode_check",
      sql`${table.analysisMode} in ('ai', 'fallback')`,
    ),
    check(
      "case_watch_findings_review_status_check",
      sql`${table.reviewStatus} in ('unreviewed', 'reviewed')`,
    ),
  ],
);
