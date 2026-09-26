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

/** Additive standard-service storage. Existing run-date watch tables keep their contract. */
export const managedDistributionSnapshots = pgTable("managed_distribution_snapshots", {
  sha256: text("sha256").primaryKey(),
  sourceUrl: text("source_url").notNull(),
  csvText: text("csv_text").notNull(),
  acquiredAt: timestamp("acquired_at", { mode: "string", withTimezone: true }).notNull(),
});
export const managedImportReceipts = pgTable("managed_import_receipts", {
  importId: integer("import_id").primaryKey().references(() => kohoImportRuns.importId, { onDelete: "cascade" }),
  sourceSha256: text("source_sha256").notNull(),
  publicationDate: text("publication_date").notNull(),
  issueNumber: text("issue_number").notNull(),
  receiptJson: text("receipt_json").notNull(),
  receiptDigest: text("receipt_digest").notNull(),
}, table => [uniqueIndex("managed_import_receipt_source").on(table.sourceSha256)]);

export const managedPublicationClaims = pgTable("managed_publication_claims", {
  documentId: integer("document_id").primaryKey().references(() => kohoImportDocuments.documentId, { onDelete: "cascade" }),
  contentSha256: text("content_sha256").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  claimsJson: text("claims_json"),
  claimsDigest: text("claims_digest"),
  status: text("status").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, table => [check("managed_publication_claims_state", sql`(${table.status} = 'complete' and ${table.claimsJson} is not null and ${table.claimsDigest} is not null and ${table.reason} is null) or (${table.status} = 'review_required' and ${table.claimsJson} is null and ${table.claimsDigest} is null and ${table.reason} is not null)`)]);

export const managedWatchSettings = pgTable("managed_watch_settings", {
  settingId: serial("setting_id").primaryKey(),
  // Ordinary case DELETE must not bypass active-contract/90-day retention.
  caseId: integer("case_id").notNull().references(() => cases.caseId, { onDelete: "restrict" }),
  contractSignedOn: text("contract_signed_on").notNull(),
  monitoringStartsOn: text("monitoring_starts_on").notNull(),
  contractEndsOn: text("contract_ends_on"),
  enabled: boolean("enabled").notNull().default(true),
  baseClaimsJson: text("base_claims_json").notNull(),
  sourceDocumentId: integer("source_document_id").notNull().references(() => priorArtDocuments.docId, {onDelete:"restrict"}),
  sourceJson: text("source_json").notNull(),
  selectedClaimsJson: text("selected_claims_json").notNull(),
  baseDigest: text("base_digest").notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("managed_watch_settings_case_unique").on(table.caseId)]);

export const managedWatchRuns = pgTable("managed_watch_runs", {
  runId: text("run_id").primaryKey(),
  settingId: integer("setting_id").notNull().references(() => managedWatchSettings.settingId, { onDelete: "cascade" }),
  caseId: integer("case_id").notNull().references(() => cases.caseId, { onDelete: "restrict" }),
  status: text("status").notNull(),
  periodFrom: text("period_from").notNull(),
  periodTo: text("period_to").notNull(),
  baseDigest: text("base_digest").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  snapshotDigest: text("snapshot_digest").notNull(),
  sourceDocumentId: integer("source_document_id").notNull().references(() => priorArtDocuments.docId, {onDelete:"restrict"}),
  planJson: text("plan_json"),
  planDigest: text("plan_digest"),
  consumedNormal: integer("consumed_normal").notNull().default(0),
  executionId: text("execution_id"),
  startReservationId: text("start_reservation_id"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { mode: "string", withTimezone: true }),
  deadlineAt: timestamp("deadline_at", { mode: "string", withTimezone: true }),
  completedAt: timestamp("completed_at", { mode: "string", withTimezone: true }),
  errorCode: text("error_code"),
  countsJson: text("counts_json"),
}, table => [check("managed_watch_runs_status", sql`${table.status} in ('prepared','running','completed','failed','unknown')`),
  check("managed_watch_runs_budget", sql`${table.consumedNormal} between 0 and 41`),
  uniqueIndex("managed_watch_runs_one_active").on(table.settingId).where(sql`${table.status} in ('prepared','running','unknown')`)]);

export const managedWatchDispatches = pgTable("managed_watch_dispatches", {
  dispatchId: serial("dispatch_id").primaryKey(),
  runId: text("run_id").notNull().references(() => managedWatchRuns.runId, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  stage: text("stage").notNull(),
  chunkIndex: integer("chunk_index"),
  inputDigest: text("input_digest").notNull(),
  requestSha256: text("request_sha256").notNull(),
  estimatedInputTokens: integer("estimated_input_tokens").notNull(),
  maximumOutputTokens: integer("maximum_output_tokens").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  status: text("status").notNull(),
  resultJson: text("result_json"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("managed_watch_dispatch_ordinal").on(table.runId, table.ordinal),
  check("managed_watch_dispatch_status", sql`${table.status} in ('reserved','reconciled','completed')`),
  check("managed_watch_dispatch_stage", sql`${table.stage} in ('screening','detail')`),
  check("managed_watch_dispatch_budget", sql`${table.ordinal} between 1 and 41 and ${table.estimatedInputTokens} between 1 and 150000 and ${table.maximumOutputTokens} between 1 and 8192`)]);

export const managedWatchFindings = pgTable("managed_watch_findings", {
  findingId: serial("finding_id").primaryKey(),
  settingId: integer("setting_id").notNull().references(() => managedWatchSettings.settingId, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => managedWatchRuns.runId, { onDelete: "cascade" }),
  baseDigest: text("base_digest").notNull(),
  sourceKey: text("source_key").notNull(),
  publicationNumber: text("publication_number").notNull(),
  publicationDate: text("publication_date").notNull(),
  periodFrom: text("period_from").notNull(),
  periodTo: text("period_to").notNull(),
  relation: text("relation").notNull(),
  analysisJson: text("analysis_json").notNull(),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  reviewVersion: integer("review_version").notNull().default(0),
  detectedAt: timestamp("detected_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("managed_watch_finding_source").on(table.settingId, table.baseDigest, table.sourceKey),
  check("managed_watch_finding_review", sql`${table.reviewStatus} in ('unreviewed','reviewed')`),
  check("managed_watch_finding_relation", sql`${table.relation} in ('own_publication','other_applicant','unknown')`)]);

export const managedWatchDeliveries = pgTable("managed_watch_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  settingId: integer("setting_id").notNull().references(() => managedWatchSettings.settingId, { onDelete: "cascade" }),
  caseId: integer("case_id").notNull().references(() => cases.caseId, { onDelete: "restrict" }),
  periodFrom: text("period_from").notNull(),
  periodTo: text("period_to").notNull(),
  version: integer("version").notNull(),
  previousDeliveryId: text("previous_delivery_id"),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  baseDigest: text("base_digest").notNull(),
  distributionSha256: text("distribution_sha256").notNull().references(() => managedDistributionSnapshots.sha256, { onDelete: "restrict" }),
  snapshotJson: text("snapshot_json").notNull(),
  snapshotDigest: text("snapshot_digest").notNull(),
  blobManifestJson: text("blob_manifest_json"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  deliveredOn: text("delivered_on"),
}, table => [uniqueIndex("managed_watch_delivery_version").on(table.settingId, table.periodFrom, table.periodTo, table.version),
  check("managed_watch_delivery_status", sql`${table.status} in ('prepared','stored','storage_unknown','abandoned')`)]);

/** Deletion intent survives case removal so failed Blob deletes can be reconciled. */
export const managedWatchDeletions = pgTable("managed_watch_deletions", {
  deletionId: text("deletion_id").primaryKey(),
  caseId: integer("case_id").notNull(),
  eligibleOn: text("eligible_on").notNull(),
  manifestJson: text("manifest_json").notNull(),
  manifestDigest: text("manifest_digest").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { mode: "string", withTimezone: true }),
}, table => [check("managed_watch_deletion_status", sql`${table.status} in ('preview','executing','complete','reconciliation_required')`)]);

/** Start reservations survive case deletion; cleanup never resets release consumption. */
export const managedWatchBackups = pgTable("managed_watch_backups", {
  backupId: text("backup_id").primaryKey(),
  caseId: integer("case_id").notNull().references(() => cases.caseId, { onDelete: "restrict" }),
  sha256: text("sha256").notNull(),
  bytes: integer("bytes").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, table => [check("managed_backup_state", sql`${table.status} in ('prepared','stored','storage_unknown','abandoned')`),
  check("managed_backup_bytes", sql`${table.bytes} between 1 and 268435456`)]);

/** Start reservations survive case deletion; cleanup never resets release consumption. */
export const managedWatchJobStarts = pgTable("managed_watch_job_starts", {
  operationId: text("operation_id").primaryKey(), configJson: text("config_json").notNull(), configDigest: text("config_digest").notNull(),
  logicalStarts: integer("logical_starts").notNull(), reservedNormal: integer("reserved_normal").notNull(), reservedMinutes: integer("reserved_minutes").notNull(),
  status: text("status").notNull(), executionId: text("execution_id"),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, table => [check("managed_job_start_status", sql`${table.status} in ('reserved','submitting','accepted','completed','unknown')`),
  check("managed_job_start_bounds", sql`${table.logicalStarts} between 1 and 3 and ${table.reservedNormal} between 0 and 123 and ${table.reservedMinutes} between 1 and 95`)]);
