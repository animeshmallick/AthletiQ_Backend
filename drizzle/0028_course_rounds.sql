CREATE TYPE "public"."course_round_status" AS ENUM('active', 'awaiting', 'readmitted', 'moved', 'left');--> statement-breakpoint
CREATE TYPE "public"."credit_kind" AS ENUM('course_unused', 'shortfall');--> statement-breakpoint
CREATE TYPE "public"."credit_status" AS ENUM('held', 'assigned', 'applied', 'refund_due', 'refunded', 'forfeited', 'void');--> statement-breakpoint
CREATE TABLE "course_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"round_no" smallint NOT NULL,
	"started_on" date NOT NULL,
	"status" "course_round_status" DEFAULT 'active' NOT NULL,
	"completed_on" date,
	"attended" smallint,
	"target" smallint,
	"historical" boolean DEFAULT false NOT NULL,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"next_enrollment_id" uuid,
	"auto_left" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"kind" "credit_kind" NOT NULL,
	"amount" integer NOT NULL,
	"status" "credit_status" NOT NULL,
	"enrollment_id" uuid,
	"round_id" uuid,
	"source_invoice_id" uuid,
	"applied_invoice_id" uuid,
	"reason" text NOT NULL,
	"settled_by_id" uuid,
	"settled_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_credits_amount_chk" CHECK ("student_credits"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_amounts_chk";--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "course_months" smallint;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "course_set_on" date;--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD COLUMN "home_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credit_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "course_rounds" ADD CONSTRAINT "course_rounds_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rounds" ADD CONSTRAINT "course_rounds_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rounds" ADD CONSTRAINT "course_rounds_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rounds" ADD CONSTRAINT "course_rounds_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rounds" ADD CONSTRAINT "course_rounds_next_enrollment_id_enrollments_id_fk" FOREIGN KEY ("next_enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_round_id_course_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."course_rounds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_source_invoice_id_invoices_id_fk" FOREIGN KEY ("source_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_applied_invoice_id_invoices_id_fk" FOREIGN KEY ("applied_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_settled_by_id_users_id_fk" FOREIGN KEY ("settled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_rounds_one_open_uq" ON "course_rounds" USING btree ("enrollment_id") WHERE "course_rounds"."status" in ('active', 'awaiting');--> statement-breakpoint
CREATE INDEX "course_rounds_student_idx" ON "course_rounds" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "course_rounds_batch_status_idx" ON "course_rounds" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "student_credits_student_idx" ON "student_credits" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "student_credits_status_idx" ON "student_credits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "student_credits_enrollment_idx" ON "student_credits" USING btree ("enrollment_id","status");--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD CONSTRAINT "makeup_sessions_home_batch_id_batches_id_fk" FOREIGN KEY ("home_batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_course_months_chk" CHECK ("batches"."course_months" is null or "batches"."course_months" between 1 and 60);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_chk" CHECK ("invoices"."total_amount" >= 0 and "invoices"."discount_amount" >= 0 and "invoices"."credit_amount" >= 0);--> statement-breakpoint
-- Backfill: a makeup counts towards the student's batch that day, when there is exactly one
-- (other than the batch visited). Ambiguous ones stay null and count towards no course.
UPDATE "makeup_sessions" m SET "home_batch_id" = (
  SELECT e.batch_id FROM "enrollments" e
  WHERE e.student_id = m.student_id AND e.batch_id <> m.batch_id
    AND e.effective_from <= coalesce(m.missed_date, m.date)
    AND (e.effective_to IS NULL OR e.effective_to >= coalesce(m.missed_date, m.date))
)
WHERE m."home_batch_id" IS NULL AND (
  SELECT count(*) FROM "enrollments" e
  WHERE e.student_id = m.student_id AND e.batch_id <> m.batch_id
    AND e.effective_from <= coalesce(m.missed_date, m.date)
    AND (e.effective_to IS NULL OR e.effective_to >= coalesce(m.missed_date, m.date))
) = 1;
