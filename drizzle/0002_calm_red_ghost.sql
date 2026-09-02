CREATE TABLE "case_watch_findings" (
	"finding_id" serial PRIMARY KEY NOT NULL,
	"watch_id" integer NOT NULL,
	"first_run_id" integer NOT NULL,
	"source_key" text NOT NULL,
	"corpus_document_id" integer,
	"package_type" text NOT NULL,
	"kind" text NOT NULL,
	"publication_number" text NOT NULL,
	"publication_date" text NOT NULL,
	"invention_title" text NOT NULL,
	"abstract_preview" text,
	"lexical_score" real NOT NULL,
	"element_score" real NOT NULL,
	"semantic_score" real NOT NULL,
	"structural_score" real NOT NULL,
	"risk_label" text NOT NULL,
	"analysis_json" text NOT NULL,
	"analysis_mode" text NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_watch_findings_source_key_check" CHECK ("case_watch_findings"."source_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "case_watch_findings_score_check" CHECK ("case_watch_findings"."lexical_score" between 0 and 1 and "case_watch_findings"."element_score" between 0 and 1 and "case_watch_findings"."semantic_score" between 0 and 1 and "case_watch_findings"."structural_score" between 0 and 1),
	CONSTRAINT "case_watch_findings_analysis_mode_check" CHECK ("case_watch_findings"."analysis_mode" in ('ai', 'fallback')),
	CONSTRAINT "case_watch_findings_review_status_check" CHECK ("case_watch_findings"."review_status" in ('unreviewed', 'reviewed'))
);
--> statement-breakpoint
CREATE TABLE "case_watch_runs" (
	"run_id" serial PRIMARY KEY NOT NULL,
	"watch_id" integer NOT NULL,
	"status" text NOT NULL,
	"monitoring_from_date" text NOT NULL,
	"base_cursor_run_updated_at" timestamp with time zone,
	"base_cursor_import_id" integer,
	"upper_cursor_run_updated_at" timestamp with time zone,
	"upper_cursor_import_id" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"scanned_import_run_count" integer DEFAULT 0 NOT NULL,
	"scanned_document_count" integer DEFAULT 0 NOT NULL,
	"prefiltered_count" integer DEFAULT 0 NOT NULL,
	"analyzed_count" integer DEFAULT 0 NOT NULL,
	"new_finding_count" integer DEFAULT 0 NOT NULL,
	"fallback_finding_count" integer DEFAULT 0 NOT NULL,
	"analysis_mode" text DEFAULT 'none' NOT NULL,
	"error_code" text,
	CONSTRAINT "case_watch_runs_status_check" CHECK ("case_watch_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "case_watch_runs_base_cursor_pair_check" CHECK (("case_watch_runs"."base_cursor_run_updated_at" is null and "case_watch_runs"."base_cursor_import_id" is null) or ("case_watch_runs"."base_cursor_run_updated_at" is not null and "case_watch_runs"."base_cursor_import_id" is not null and "case_watch_runs"."base_cursor_import_id" > 0)),
	CONSTRAINT "case_watch_runs_upper_cursor_pair_check" CHECK (("case_watch_runs"."upper_cursor_run_updated_at" is null and "case_watch_runs"."upper_cursor_import_id" is null) or ("case_watch_runs"."upper_cursor_run_updated_at" is not null and "case_watch_runs"."upper_cursor_import_id" is not null and "case_watch_runs"."upper_cursor_import_id" > 0)),
	CONSTRAINT "case_watch_runs_counts_check" CHECK ("case_watch_runs"."scanned_import_run_count" >= 0 and "case_watch_runs"."scanned_document_count" >= 0 and "case_watch_runs"."prefiltered_count" >= 0 and "case_watch_runs"."analyzed_count" >= 0 and "case_watch_runs"."new_finding_count" >= 0 and "case_watch_runs"."fallback_finding_count" >= 0),
	CONSTRAINT "case_watch_runs_analysis_mode_check" CHECK ("case_watch_runs"."analysis_mode" in ('none', 'ai', 'fallback'))
);
--> statement-breakpoint
CREATE TABLE "case_watch_settings" (
	"watch_id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"monitoring_from_date" text NOT NULL,
	"cursor_run_updated_at" timestamp with time zone,
	"cursor_import_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_watch_settings_cursor_pair_check" CHECK (("case_watch_settings"."cursor_run_updated_at" is null and "case_watch_settings"."cursor_import_id" is null) or ("case_watch_settings"."cursor_run_updated_at" is not null and "case_watch_settings"."cursor_import_id" is not null and "case_watch_settings"."cursor_import_id" > 0))
);
--> statement-breakpoint
ALTER TABLE "case_watch_findings" ADD CONSTRAINT "case_watch_findings_watch_id_case_watch_settings_watch_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."case_watch_settings"("watch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_watch_findings" ADD CONSTRAINT "case_watch_findings_first_run_id_case_watch_runs_run_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."case_watch_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_watch_findings" ADD CONSTRAINT "case_watch_findings_corpus_document_id_koho_import_documents_document_id_fk" FOREIGN KEY ("corpus_document_id") REFERENCES "public"."koho_import_documents"("document_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_watch_runs" ADD CONSTRAINT "case_watch_runs_watch_id_case_watch_settings_watch_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."case_watch_settings"("watch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_watch_settings" ADD CONSTRAINT "case_watch_settings_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_watch_findings_watch_id_source_key_unique" ON "case_watch_findings" USING btree ("watch_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "case_watch_settings_case_id_unique" ON "case_watch_settings" USING btree ("case_id");