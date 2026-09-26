CREATE TABLE "managed_watch_job_starts" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"config_json" text NOT NULL,
	"config_digest" text NOT NULL,
	"logical_starts" integer NOT NULL,
	"reserved_normal" integer NOT NULL,
	"reserved_minutes" integer NOT NULL,
	"status" text NOT NULL,
	"execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_job_start_status" CHECK ("managed_watch_job_starts"."status" in ('reserved','submitting','accepted','completed','unknown')),
	CONSTRAINT "managed_job_start_bounds" CHECK ("managed_watch_job_starts"."logical_starts" between 1 and 3 and "managed_watch_job_starts"."reserved_normal" between 0 and 123 and "managed_watch_job_starts"."reserved_minutes" between 1 and 95)
);
--> statement-breakpoint
ALTER TABLE "managed_watch_runs" ADD COLUMN "start_reservation_id" text;