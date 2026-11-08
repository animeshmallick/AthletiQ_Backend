CREATE TYPE "public"."makeup_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD COLUMN "status" "makeup_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "makeup_sessions" ADD CONSTRAINT "makeup_sessions_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "makeup_status_idx" ON "makeup_sessions" USING btree ("status");