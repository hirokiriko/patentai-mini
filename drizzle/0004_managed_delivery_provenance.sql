CREATE TABLE "managed_distribution_snapshots" (
	"sha256" text PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"csv_text" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_import_receipts" (
	"import_id" integer PRIMARY KEY NOT NULL,
	"source_sha256" text NOT NULL,
	"publication_date" text NOT NULL,
	"issue_number" text NOT NULL,
	"receipt_json" text NOT NULL,
	"receipt_digest" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" DROP CONSTRAINT "managed_watch_delivery_status";--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" ADD COLUMN "base_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" ADD COLUMN "distribution_sha256" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_import_receipts" ADD CONSTRAINT "managed_import_receipts_import_id_koho_import_runs_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."koho_import_runs"("import_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_import_receipt_source" ON "managed_import_receipts" USING btree ("source_sha256");--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" ADD CONSTRAINT "managed_watch_deliveries_distribution_sha256_managed_distribution_snapshots_sha256_fk" FOREIGN KEY ("distribution_sha256") REFERENCES "public"."managed_distribution_snapshots"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_watch_deliveries" ADD CONSTRAINT "managed_watch_delivery_status" CHECK ("managed_watch_deliveries"."status" in ('prepared','stored','storage_unknown','abandoned'));