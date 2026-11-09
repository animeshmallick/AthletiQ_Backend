-- Batches created before capacity was required get 5.
UPDATE "batches" SET "capacity" = 5 WHERE "capacity" IS NULL;--> statement-breakpoint
ALTER TABLE "batches" ALTER COLUMN "capacity" SET NOT NULL;
