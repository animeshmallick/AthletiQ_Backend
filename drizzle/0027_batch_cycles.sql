CREATE TYPE "public"."session_change_kind" AS ENUM('reschedule', 'extra');--> statement-breakpoint
CREATE TYPE "public"."session_change_status" AS ENUM('approved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."cycle_status" AS ENUM('active', 'completed', 'exited');--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'lost';--> statement-breakpoint
CREATE TABLE "session_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" "session_change_kind" NOT NULL,
	"original_date" date,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" "session_change_status" DEFAULT 'approved' NOT NULL,
	"reason" text,
	"requested_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_changes_kind_chk" CHECK (("session_changes"."kind" = 'extra' and "session_changes"."original_date" is null) or ("session_changes"."kind" = 'reschedule' and "session_changes"."original_date" is not null)),
	CONSTRAINT "session_changes_time_chk" CHECK ("session_changes"."end_time" > "session_changes"."start_time")
);
--> statement-breakpoint
CREATE TABLE "batch_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"round_no" smallint NOT NULL,
	"first_month" integer NOT NULL,
	"months" smallint NOT NULL,
	"per_month" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "cycle_status" DEFAULT 'active' NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_cycles_range_chk" CHECK ("batch_cycles"."ends_on" >= "batch_cycles"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "course_months" smallint;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "course_set_on" date;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "planned_end_on" date;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "planned_reason" text;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "planned_by_id" uuid;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "planned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "planned_move_to_id" uuid;--> statement-breakpoint
ALTER TABLE "coach_sessions" ADD COLUMN "outside_time" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD COLUMN "missed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD COLUMN "closed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "lost_by_id" uuid;--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_changes" ADD CONSTRAINT "session_changes_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_cycles" ADD CONSTRAINT "batch_cycles_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_cycles" ADD CONSTRAINT "batch_cycles_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_cycles" ADD CONSTRAINT "batch_cycles_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_changes_batch_date_uq" ON "session_changes" USING btree ("batch_id","date") WHERE "session_changes"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "session_changes_batch_original_uq" ON "session_changes" USING btree ("batch_id","original_date") WHERE "session_changes"."status" = 'approved' and "session_changes"."original_date" is not null;--> statement-breakpoint
CREATE INDEX "session_changes_date_idx" ON "session_changes" USING btree ("date");--> statement-breakpoint
CREATE INDEX "session_changes_status_idx" ON "session_changes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_cycles_round_uq" ON "batch_cycles" USING btree ("enrollment_id","round_no");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_cycles_one_active_uq" ON "batch_cycles" USING btree ("enrollment_id") WHERE "batch_cycles"."status" = 'active';--> statement-breakpoint
CREATE INDEX "batch_cycles_student_idx" ON "batch_cycles" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "batch_cycles_batch_idx" ON "batch_cycles" USING btree ("batch_id","status","ends_on");--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_planned_by_id_users_id_fk" FOREIGN KEY ("planned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_planned_move_to_id_batches_id_fk" FOREIGN KEY ("planned_move_to_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD CONSTRAINT "session_cancellations_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_lost_by_id_users_id_fk" FOREIGN KEY ("lost_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollments_planned_end_idx" ON "enrollments" USING btree ("planned_end_on");--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_course_months_chk" CHECK ("batches"."course_months" is null or "batches"."course_months" between 1 and 60);--> statement-breakpoint
-- Makeups are no longer offered: requests still waiting are closed (approved ones are honoured).
UPDATE "makeup_sessions" SET "status" = 'rejected', "review_note" = 'Makeup sessions are no longer offered', "reviewed_at" = now() WHERE "status" = 'pending';
