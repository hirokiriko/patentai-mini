CREATE TABLE "cases" (
	"case_id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_application_mode" boolean DEFAULT false NOT NULL,
	"base_application_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparison_results" (
	"result_id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"draft_claim_id" text,
	"prior_doc_id" integer,
	"lexical_score" real,
	"semantic_score" real,
	"structural_score" real,
	"matched_elements_json" text,
	"risk_label" text
);
--> statement-breakpoint
CREATE TABLE "draft_patents" (
	"draft_id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"kind" text DEFAULT 'main' NOT NULL,
	"source_file_path" text,
	"parsed_text" text,
	"extracted_claims_json" text
);
--> statement-breakpoint
CREATE TABLE "prior_art_documents" (
	"doc_id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"publication_no" text,
	"title" text,
	"abstract" text,
	"claims_text" text,
	"source_csv_row_json" text,
	"normalized_elements_json" text
);
--> statement-breakpoint
CREATE TABLE "search_query_sets" (
	"query_set_id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"broad_query" text,
	"balanced_query" text,
	"narrow_query" text,
	"rationale_json" text
);
--> statement-breakpoint
ALTER TABLE "comparison_results" ADD CONSTRAINT "comparison_results_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_results" ADD CONSTRAINT "comparison_results_prior_doc_id_prior_art_documents_doc_id_fk" FOREIGN KEY ("prior_doc_id") REFERENCES "public"."prior_art_documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_patents" ADD CONSTRAINT "draft_patents_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prior_art_documents" ADD CONSTRAINT "prior_art_documents_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_query_sets" ADD CONSTRAINT "search_query_sets_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE no action ON UPDATE no action;