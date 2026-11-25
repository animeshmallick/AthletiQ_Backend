CREATE TABLE "makeup_excusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"student_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD COLUMN "missed_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "student_attendance" ADD COLUMN "home_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "makeup_excusals" ADD CONSTRAINT "makeup_excusals_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "makeup_excusals" ADD CONSTRAINT "makeup_excusals_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "makeup_excusals" ADD CONSTRAINT "makeup_excusals_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "makeup_excusals_uq" ON "makeup_excusals" USING btree ("batch_id","date","student_id");--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD CONSTRAINT "makeup_sessions_missed_batch_id_batches_id_fk" FOREIGN KEY ("missed_batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_home_batch_id_batches_id_fk" FOREIGN KEY ("home_batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "makeup_missed_student_uq" ON "makeup_sessions" USING btree ("missed_batch_id","missed_date","student_id") WHERE "makeup_sessions"."missed_batch_id" is not null and "makeup_sessions"."status" = 'approved';