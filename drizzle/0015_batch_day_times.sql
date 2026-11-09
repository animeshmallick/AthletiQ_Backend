ALTER TABLE "batches" ADD COLUMN "day_times" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_sessions" ADD COLUMN "scheduled_start" time;--> statement-breakpoint
ALTER TABLE "coach_sessions" ADD COLUMN "scheduled_end" time;--> statement-breakpoint
-- Past sessions ran at the batch's (single) time.
UPDATE "coach_sessions" cs SET "scheduled_start" = b."start_time", "scheduled_end" = b."end_time"
  FROM "batches" b WHERE b."id" = cs."batch_id";--> statement-breakpoint
ALTER TABLE "coach_sessions" ALTER COLUMN "scheduled_start" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_sessions" ALTER COLUMN "scheduled_end" SET NOT NULL;
