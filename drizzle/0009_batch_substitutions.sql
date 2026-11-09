CREATE TYPE "public"."substitution_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "batch_substitutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"substitute_coach_id" uuid NOT NULL,
	"coach_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" text,
	"status" "substitution_status" DEFAULT 'pending' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_subs_range_chk" CHECK ("batch_substitutions"."to_date" >= "batch_substitutions"."from_date"),
	CONSTRAINT "batch_subs_not_self_chk" CHECK ("batch_substitutions"."substitute_coach_id" <> "batch_substitutions"."coach_id")
);
--> statement-breakpoint
ALTER TABLE "batch_substitutions" ADD CONSTRAINT "batch_substitutions_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_substitutions" ADD CONSTRAINT "batch_substitutions_substitute_coach_id_users_id_fk" FOREIGN KEY ("substitute_coach_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_substitutions" ADD CONSTRAINT "batch_substitutions_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_substitutions" ADD CONSTRAINT "batch_substitutions_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_substitutions" ADD CONSTRAINT "batch_substitutions_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_subs_batch_idx" ON "batch_substitutions" USING btree ("batch_id","from_date");--> statement-breakpoint
CREATE INDEX "batch_subs_substitute_idx" ON "batch_substitutions" USING btree ("substitute_coach_id","from_date");--> statement-breakpoint
CREATE INDEX "batch_subs_status_idx" ON "batch_substitutions" USING btree ("status");