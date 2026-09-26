CREATE TABLE "managed_watch_backups" (
	"backup_id" text PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_backup_state" CHECK ("managed_watch_backups"."status" in ('prepared','stored','storage_unknown','abandoned')),
	CONSTRAINT "managed_backup_bytes" CHECK ("managed_watch_backups"."bytes" between 1 and 268435456)
);
--> statement-breakpoint
ALTER TABLE "managed_watch_backups" ADD CONSTRAINT "managed_watch_backups_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("case_id") ON DELETE restrict ON UPDATE no action;