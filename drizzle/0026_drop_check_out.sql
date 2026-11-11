DROP INDEX "coach_sessions_flagged_idx";--> statement-breakpoint
CREATE INDEX "coach_sessions_flagged_idx" ON "coach_sessions" USING btree ("date") WHERE "coach_sessions"."check_in_within_fence" = false;--> statement-breakpoint
ALTER TABLE "coach_sessions" DROP COLUMN "check_out_at";--> statement-breakpoint
ALTER TABLE "coach_sessions" DROP COLUMN "check_out_lat";--> statement-breakpoint
ALTER TABLE "coach_sessions" DROP COLUMN "check_out_lng";--> statement-breakpoint
ALTER TABLE "coach_sessions" DROP COLUMN "check_out_accuracy_m";--> statement-breakpoint
ALTER TABLE "coach_sessions" DROP COLUMN "check_out_distance_m";--> statement-breakpoint
ALTER TABLE "coach_sessions" DROP COLUMN "check_out_within_fence";