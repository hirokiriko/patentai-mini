CREATE TABLE "managed_publication_claims" (
	"document_id" integer PRIMARY KEY NOT NULL,
	"content_sha256" text NOT NULL,
	"source_sha256" text NOT NULL,
	"claims_json" text,
	"claims_digest" text,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_publication_claims_state" CHECK (("managed_publication_claims"."status" = 'complete' and "managed_publication_claims"."claims_json" is not null and "managed_publication_claims"."claims_digest" is not null and "managed_publication_claims"."reason" is null) or ("managed_publication_claims"."status" = 'review_required' and "managed_publication_claims"."claims_json" is null and "managed_publication_claims"."claims_digest" is null and "managed_publication_claims"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "managed_watch_deletions" (
	"deletion_id" text PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"eligible_on" text NOT NULL,
	"manifest_json" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "managed_watch_deletion_status" CHECK ("managed_watch_deletions"."status" in ('preview','executing','complete','reconciliation_required'))
);
--> statement-breakpoint
CREATE TABLE "managed_watch_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"setting_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"period_from" text NOT NULL,
	"period_to" text NOT NULL,
	"version" integer NOT NULL,
	"previous_delivery_id" text,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"blob_manifest_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_on" text,
	CONSTRAINT "managed_watch_delivery_status" CHECK ("managed_watch_deliveries"."status" in ('prepared','stored','storage_unknown'))
);
--> statement-breakpoint
CREATE TABLE "managed_watch_dispatches" (
	"dispatch_id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"stage" text NOT NULL,
	"chunk_index" integer,
	"input_digest" text NOT NULL,
	"request_sha256" text NOT NULL,
	"estimated_input_tokens" integer NOT NULL,
	"maximum_output_tokens" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"status" text NOT NULL,
	"result_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_watch_dispatch_status" CHECK ("managed_watch_dispatches"."status" in ('reserved','reconciled','completed')),
	CONSTRAINT "managed_watch_dispatch_stage" CHECK ("managed_watch_dispatches"."stage" in ('screening','detail')),
	CONSTRAINT "managed_watch_dispatch_budget" CHECK ("managed_watch_dispatches"."ordinal" between 1 and 41 and "managed_watch_dispatches"."estimated_input_tokens" between 1 and 150000 and "managed_watch_dispatches"."maximum_output_tokens" between 1 and 8192)
);
--> statement-breakpoint
CREATE TABLE "managed_watch_findings" (
	"finding_id" serial PRIMARY KEY NOT NULL,
	"setting_id" integer NOT NULL,
	"run_id" text NOT NULL,
	"base_digest" text NOT NULL,
	"source_key" text NOT NULL,
	"publication_number" text NOT NULL,
	"publication_date" text NOT NULL,
	"period_from" text NOT NULL,
	"period_to" text NOT NULL,
	"relation" text NOT NULL,
	"analysis_json" text NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_watch_finding_review" CHECK ("managed_watch_findings"."review_status" in ('unreviewed','reviewed')),
	CONSTRAINT "managed_watch_finding_relation" CHECK ("managed_watch_findings"."relation" in ('own_publication','other_applicant','unknown'))
);
--> statement-breakpoint
CREATE TABLE "managed_watch_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"setting_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"status" text NOT NULL,
	"period_from" text NOT NULL,
	"period_to" text NOT NULL,
	"base_digest" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"plan_json" text,
	"plan_digest" text,
	"consumed_normal" integer DEFAULT 0 NOT NULL,
	"execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"counts_json" text,
	CONSTRAINT "managed_watch_runs_status" CHECK ("managed_watch_runs"."status" in ('prepared','running','completed','failed','unknown')),
	CONSTRAINT "managed_watch_runs_budget" CHECK ("managed_watch_runs"."consumed_normal" between 0 and 41)
);
--> statement-breakpoint
CREATE TABLE "managed_watch_settings" (
	"setting_id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"contract_signed_on" text NOT NULL,
	"monitoring_starts_on" text NOT NULL,
	"contract_ends_on" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"base_claims_json" text NOT NULL,
	"selected_claims_json" text NOT NULL,
	"base_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_publication_claims" ADD CONSTRAINT "managed_publication_claims_document_id_koho_import_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."koho_import_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" ADD CONSTRAINT "managed_watch_deliveries_setting_id_managed_watch_settings_setting_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."managed_watch_settings"("setting_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" ADD CONSTRAINT "managed_watch_deliveries_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_dispatches" ADD CONSTRAINT "managed_watch_dispatches_run_id_managed_watch_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."managed_watch_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_findings" ADD CONSTRAINT "managed_watch_findings_setting_id_managed_watch_settings_setting_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."managed_watch_settings"("setting_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_findings" ADD CONSTRAINT "managed_watch_findings_run_id_managed_watch_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."managed_watch_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_runs" ADD CONSTRAINT "managed_watch_runs_setting_id_managed_watch_settings_setting_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."managed_watch_settings"("setting_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_runs" ADD CONSTRAINT "managed_watch_runs_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_settings" ADD CONSTRAINT "managed_watch_settings_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_watch_delivery_version" ON "managed_watch_deliveries" USING btree ("setting_id","period_from","period_to","version");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_watch_dispatch_ordinal" ON "managed_watch_dispatches" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_watch_finding_source" ON "managed_watch_findings" USING btree ("setting_id","base_digest","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_watch_runs_one_active" ON "managed_watch_runs" USING btree ("setting_id") WHERE "managed_watch_runs"."status" in ('prepared','running','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "managed_watch_settings_case_unique" ON "managed_watch_settings" USING btree ("case_id");