-- Multi-batch billing: each batch has one fee plan; a student can be in several batches and
-- every batch membership (enrollment) is billed on its own. Existing data keeps billing exactly
-- as before (same plan, fee, discount and monthly date).

-- 1. Batches get a fee plan: the plan most of its students are on, else a plan whose days per
--    week match the batch, else the first plan. (Fails loudly if a batch exists and no plan does.)
ALTER TABLE "batches" ADD COLUMN "fee_plan_id" uuid;--> statement-breakpoint
UPDATE "batches" b SET "fee_plan_id" = COALESCE(
  (SELECT s."fee_plan_id" FROM "enrollments" e JOIN "students" s ON s."id" = e."student_id"
    WHERE e."batch_id" = b."id"
    GROUP BY s."fee_plan_id" ORDER BY (count(*) FILTER (WHERE e."effective_to" IS NULL)) DESC, count(*) DESC LIMIT 1),
  (SELECT f."id" FROM "fee_plans" f WHERE f."days_per_week" = cardinality(b."weekdays")
    ORDER BY f."is_active" DESC, f."created_at" LIMIT 1),
  (SELECT f."id" FROM "fee_plans" f ORDER BY f."is_active" DESC, f."created_at" LIMIT 1)
);--> statement-breakpoint
ALTER TABLE "batches" ALTER COLUMN "fee_plan_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_fee_plan_id_fee_plans_id_fk" FOREIGN KEY ("fee_plan_id") REFERENCES "public"."fee_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_fee_plan_idx" ON "batches" USING btree ("fee_plan_id");--> statement-breakpoint

-- 2. Billing moves to enrollments.
ALTER TABLE "enrollments" ADD COLUMN "custom_monthly_fee" integer;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "monthly_discount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "billing_starts_on" date;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "billing_anchor_date" date;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "cycle_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Students train on every day their batch runs.
UPDATE "enrollments" e SET "training_days" = b."weekdays" FROM "batches" b WHERE b."id" = e."batch_id" AND e."effective_to" IS NULL;--> statement-breakpoint
-- The open enrollment carries the student's billing run on: same anchor, numbering, fee and
-- discount; nothing already invoiced is billed again.
UPDATE "enrollments" e SET
  "custom_monthly_fee" = s."custom_monthly_fee",
  "monthly_discount" = s."monthly_discount",
  "billing_anchor_date" = COALESCE(s."billing_anchor_date", s."joining_date"),
  "cycle_offset" = s."cycle_offset",
  "billing_starts_on" = GREATEST(
    s."billing_starts_on",
    COALESCE((SELECT max(i."period_end") + 1 FROM "invoices" i
      WHERE i."student_id" = s."id" AND i."cycle_number" > s."cycle_offset"), s."billing_starts_on")
  )
FROM "students" s
WHERE s."id" = e."student_id" AND e."effective_to" IS NULL;--> statement-breakpoint
-- Closed (past) memberships are history: nothing more is billed for them.
UPDATE "enrollments" e SET
  "custom_monthly_fee" = s."custom_monthly_fee",
  "monthly_discount" = s."monthly_discount",
  "billing_anchor_date" = COALESCE(s."billing_anchor_date", s."joining_date"),
  "cycle_offset" = s."cycle_offset",
  "billing_starts_on" = e."effective_to" + 1
FROM "students" s
WHERE s."id" = e."student_id" AND e."effective_to" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ALTER COLUMN "billing_starts_on" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_custom_fee_chk" CHECK ("enrollments"."custom_monthly_fee" is null or "enrollments"."custom_monthly_fee" >= 0);--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_discount_chk" CHECK ("enrollments"."monthly_discount" >= 0);--> statement-breakpoint
DROP INDEX "enrollments_one_open_per_student_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_one_open_per_batch_uq" ON "enrollments" USING btree ("student_id","batch_id") WHERE "enrollments"."effective_to" is null;--> statement-breakpoint

-- 3. Invoices belong to the membership they bill: the one in the invoice's batch covering its
--    period (else the student's latest membership in that batch, else their latest at all).
ALTER TABLE "invoices" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
UPDATE "invoices" i SET "enrollment_id" = COALESCE(
  (SELECT e."id" FROM "enrollments" e
    WHERE e."student_id" = i."student_id" AND e."batch_id" = i."batch_id"
      AND e."effective_from" <= i."period_end"
      AND (e."effective_to" IS NULL OR e."effective_to" >= i."period_start")
    ORDER BY e."effective_from" DESC LIMIT 1),
  (SELECT e."id" FROM "enrollments" e
    WHERE e."student_id" = i."student_id" AND e."batch_id" = i."batch_id"
    ORDER BY e."effective_from" DESC LIMIT 1),
  (SELECT e."id" FROM "enrollments" e
    WHERE e."student_id" = i."student_id"
    ORDER BY (e."effective_to" IS NULL) DESC, e."effective_from" DESC LIMIT 1)
);--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "enrollment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP INDEX "invoices_student_cycle_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_enrollment_cycle_uq" ON "invoices" USING btree ("enrollment_id","cycle_number");--> statement-breakpoint
CREATE INDEX "invoices_student_idx" ON "invoices" USING btree ("student_id");--> statement-breakpoint

-- 4. Weekly feedback: one per student per batch per week (each batch's coach writes their own).
DROP INDEX "weekly_feedback_student_week_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_feedback_student_batch_week_uq" ON "weekly_feedback" USING btree ("student_id","batch_id","week_start");--> statement-breakpoint

-- 5. The student-level billing columns are no longer used.
ALTER TABLE "students" DROP CONSTRAINT "students_custom_fee_chk";--> statement-breakpoint
ALTER TABLE "students" DROP CONSTRAINT "students_discount_chk";--> statement-breakpoint
ALTER TABLE "students" DROP CONSTRAINT "students_fee_plan_id_fee_plans_id_fk";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "fee_plan_id";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "custom_monthly_fee";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "monthly_discount";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "billing_starts_on";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "billing_anchor_date";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "cycle_offset";
