DROP INDEX "lesson_events_coach_name_uq";--> statement-breakpoint
DROP INDEX "lesson_events_coach_idx";--> statement-breakpoint
DROP INDEX "lesson_stages_coach_name_uq";--> statement-breakpoint
DROP INDEX "lesson_stages_coach_idx";--> statement-breakpoint
ALTER TABLE "lesson_events" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "lesson_stages" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
-- Templates move from coach to batch: every (item, batch) pair the item belongs to — the
-- coach's batches, plus any batch whose plans already use it. The first pair keeps the row;
-- the rest get copies, and plans/cells in those batches are repointed at the copies.
CREATE TABLE "_lesson_item_map" ("kind" text NOT NULL, "old_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "rn" integer NOT NULL, "new_id" uuid);--> statement-breakpoint
INSERT INTO "_lesson_item_map" ("kind", "old_id", "batch_id", "rn")
SELECT 'stage', i."id", b."id", row_number() OVER (PARTITION BY i."id" ORDER BY b."created_at", b."id")
FROM "lesson_stages" i
JOIN "batches" b ON b."coach_id" = i."coach_id"
  OR EXISTS (SELECT 1 FROM "lesson_plans" p WHERE p."batch_id" = b."id" AND i."id" = ANY(p."stage_ids"));--> statement-breakpoint
UPDATE "_lesson_item_map" SET "new_id" = CASE WHEN "rn" = 1 THEN "old_id" ELSE gen_random_uuid() END WHERE "kind" = 'stage';--> statement-breakpoint
INSERT INTO "lesson_stages" ("id", "batch_id", "coach_id", "name", "color", "sort_order", "is_archived", "created_at", "updated_at")
SELECT m."new_id", m."batch_id", i."coach_id", i."name", i."color", i."sort_order", i."is_archived", i."created_at", i."updated_at"
FROM "_lesson_item_map" m JOIN "lesson_stages" i ON i."id" = m."old_id"
WHERE m."kind" = 'stage' AND m."rn" > 1;--> statement-breakpoint
UPDATE "lesson_stages" i SET "batch_id" = m."batch_id" FROM "_lesson_item_map" m
WHERE m."kind" = 'stage' AND m."rn" = 1 AND i."id" = m."old_id";--> statement-breakpoint
UPDATE "lesson_plans" p SET "stage_ids" = ARRAY(
  SELECT coalesce(m."new_id", u."id")
  FROM unnest(p."stage_ids") WITH ORDINALITY AS u("id", "ord")
  LEFT JOIN "_lesson_item_map" m ON m."kind" = 'stage' AND m."old_id" = u."id" AND m."batch_id" = p."batch_id"
  ORDER BY u."ord"
);--> statement-breakpoint
UPDATE "lesson_plan_cells" c SET "stage_id" = m."new_id"
FROM "lesson_plans" p, "_lesson_item_map" m
WHERE c."plan_id" = p."id" AND m."kind" = 'stage' AND m."old_id" = c."stage_id" AND m."batch_id" = p."batch_id" AND m."rn" > 1;--> statement-breakpoint
-- Items of coaches with no batch were never used in a plan: nothing to keep them for.
DELETE FROM "lesson_stages" WHERE "batch_id" IS NULL;--> statement-breakpoint
-- Two coaches' items can meet in one batch: keep names unique within the batch.
UPDATE "lesson_stages" i SET "name" = i."name" || ' (' || d."n" || ')'
FROM (SELECT "id", row_number() OVER (PARTITION BY "batch_id", lower("name") ORDER BY "created_at", "id") AS "n" FROM "lesson_stages") d
WHERE d."id" = i."id" AND d."n" > 1;--> statement-breakpoint
ALTER TABLE "lesson_stages" ALTER COLUMN "batch_id" SET NOT NULL;--> statement-breakpoint
INSERT INTO "_lesson_item_map" ("kind", "old_id", "batch_id", "rn")
SELECT 'event', i."id", b."id", row_number() OVER (PARTITION BY i."id" ORDER BY b."created_at", b."id")
FROM "lesson_events" i
JOIN "batches" b ON b."coach_id" = i."coach_id"
  OR EXISTS (SELECT 1 FROM "lesson_plans" p WHERE p."batch_id" = b."id" AND i."id" = ANY(p."event_ids"));--> statement-breakpoint
UPDATE "_lesson_item_map" SET "new_id" = CASE WHEN "rn" = 1 THEN "old_id" ELSE gen_random_uuid() END WHERE "kind" = 'event';--> statement-breakpoint
INSERT INTO "lesson_events" ("id", "batch_id", "coach_id", "name", "description", "sort_order", "is_archived", "created_at", "updated_at")
SELECT m."new_id", m."batch_id", i."coach_id", i."name", i."description", i."sort_order", i."is_archived", i."created_at", i."updated_at"
FROM "_lesson_item_map" m JOIN "lesson_events" i ON i."id" = m."old_id"
WHERE m."kind" = 'event' AND m."rn" > 1;--> statement-breakpoint
UPDATE "lesson_events" i SET "batch_id" = m."batch_id" FROM "_lesson_item_map" m
WHERE m."kind" = 'event' AND m."rn" = 1 AND i."id" = m."old_id";--> statement-breakpoint
UPDATE "lesson_plans" p SET "event_ids" = ARRAY(
  SELECT coalesce(m."new_id", u."id")
  FROM unnest(p."event_ids") WITH ORDINALITY AS u("id", "ord")
  LEFT JOIN "_lesson_item_map" m ON m."kind" = 'event' AND m."old_id" = u."id" AND m."batch_id" = p."batch_id"
  ORDER BY u."ord"
);--> statement-breakpoint
UPDATE "lesson_plan_cells" c SET "event_id" = m."new_id"
FROM "lesson_plans" p, "_lesson_item_map" m
WHERE c."plan_id" = p."id" AND m."kind" = 'event' AND m."old_id" = c."event_id" AND m."batch_id" = p."batch_id" AND m."rn" > 1;--> statement-breakpoint
-- Items of coaches with no batch were never used in a plan: nothing to keep them for.
DELETE FROM "lesson_events" WHERE "batch_id" IS NULL;--> statement-breakpoint
-- Two coaches' items can meet in one batch: keep names unique within the batch.
UPDATE "lesson_events" i SET "name" = i."name" || ' (' || d."n" || ')'
FROM (SELECT "id", row_number() OVER (PARTITION BY "batch_id", lower("name") ORDER BY "created_at", "id") AS "n" FROM "lesson_events") d
WHERE d."id" = i."id" AND d."n" > 1;--> statement-breakpoint
ALTER TABLE "lesson_events" ALTER COLUMN "batch_id" SET NOT NULL;--> statement-breakpoint
DROP TABLE "_lesson_item_map";--> statement-breakpoint
ALTER TABLE "lesson_events" ADD CONSTRAINT "lesson_events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_stages" ADD CONSTRAINT "lesson_stages_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_events_batch_name_uq" ON "lesson_events" USING btree ("batch_id",lower("name"));--> statement-breakpoint
CREATE INDEX "lesson_events_batch_idx" ON "lesson_events" USING btree ("batch_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_stages_batch_name_uq" ON "lesson_stages" USING btree ("batch_id",lower("name"));--> statement-breakpoint
CREATE INDEX "lesson_stages_batch_idx" ON "lesson_stages" USING btree ("batch_id","sort_order");