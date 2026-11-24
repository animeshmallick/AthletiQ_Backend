CREATE TYPE "public"."shortfall_status" AS ENUM('at_risk', 'short', 'recovered', 'discounted', 'extra_added', 'dismissed');--> statement-breakpoint
CREATE TABLE "session_shortfalls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"cycle_number" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"target" smallint NOT NULL,
	"held" smallint NOT NULL,
	"remaining" smallint NOT NULL,
	"status" "shortfall_status" NOT NULL,
	"amount" integer,
	"credit_id" uuid,
	"invoice_id" uuid,
	"session_change_id" uuid,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_shortfalls" ADD CONSTRAINT "session_shortfalls_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shortfalls" ADD CONSTRAINT "session_shortfalls_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shortfalls" ADD CONSTRAINT "session_shortfalls_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shortfalls" ADD CONSTRAINT "session_shortfalls_credit_id_student_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."student_credits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shortfalls" ADD CONSTRAINT "session_shortfalls_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shortfalls" ADD CONSTRAINT "session_shortfalls_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_shortfalls_cycle_uq" ON "session_shortfalls" USING btree ("enrollment_id","cycle_number");--> statement-breakpoint
CREATE INDEX "session_shortfalls_status_idx" ON "session_shortfalls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "session_shortfalls_batch_idx" ON "session_shortfalls" USING btree ("batch_id","status");