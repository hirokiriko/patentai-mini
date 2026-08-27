CREATE TABLE "koho_import_documents" (
	"document_id" serial PRIMARY KEY NOT NULL,
	"import_id" integer NOT NULL,
	"normalized_entry_path" text NOT NULL,
	"parse_status" text NOT NULL,
	"kind" text NOT NULL,
	"publication_number" text NOT NULL,
	"application_number" text NOT NULL,
	"publication_date" text NOT NULL,
	"registration_number" text,
	"registration_date" text,
	"invention_title" text NOT NULL,
	"abstract_text" text,
	"claims_text" text NOT NULL,
	"applicants_json" text NOT NULL,
	"ipc_json" text NOT NULL,
	"fi_json" text NOT NULL,
	"parse_issues_json" text NOT NULL,
	"source_metadata_json" text NOT NULL,
	"content_sha256" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "koho_import_runs" (
	"import_id" serial PRIMARY KEY NOT NULL,
	"package_type" text NOT NULL,
	"source_sha256" text NOT NULL,
	"package_status" text NOT NULL,
	"document_count" integer NOT NULL,
	"amendment_count" integer NOT NULL,
	"nested_st26_count" integer NOT NULL,
	"counts_json" text NOT NULL,
	"issues_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "koho_import_documents" ADD CONSTRAINT "koho_import_documents_import_id_koho_import_runs_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."koho_import_runs"("import_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "koho_import_documents_import_id_normalized_entry_path_unique" ON "koho_import_documents" USING btree ("import_id","normalized_entry_path");--> statement-breakpoint
CREATE UNIQUE INDEX "koho_import_runs_package_type_source_sha256_unique" ON "koho_import_runs" USING btree ("package_type","source_sha256");