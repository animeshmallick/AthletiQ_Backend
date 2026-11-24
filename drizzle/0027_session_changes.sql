CREATE TYPE "public"."session_change_kind" AS ENUM('reschedule', 'extra');--> statement-breakpoint
CREATE TYPE "public"."session_change_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "session_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" "session_change_kind" NOT NULL,
	"original_date" date,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" "session_change_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"requested_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_changes_kind_chk" CHECK (("session_changes"."kind" = 'extra' and "session_changes"."original_date" is null) or ("session_changes"."kind" = 'reschedule' and "session_changes"."original_date" is not null)),
	CONSTRAINT "session_changes_time_chk" CHECK ("session_changes"."end_time" > "session_changes"."start_time")
);
--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_changes_batch_date_uq" ON "session_changes" USING btree ("batch_id","date") WHERE "session_changes"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "session_changes_batch_original_uq" ON "session_changes" USING btree ("batch_id","original_date") WHERE "session_changes"."status" in ('pending', 'approved') and "session_changes"."original_date" is not null;--> statement-breakpoint
CREATE INDEX "session_changes_date_idx" ON "session_changes" USING btree ("date");--> statement-breakpoint
CREATE INDEX "session_changes_status_idx" ON "session_changes" USING btree ("status");