CREATE TABLE "lesson_plan_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coach_id" uuid NOT NULL,
	"name" text NOT NULL,
	"focus" text,
	"notes" text,
	"stage_ids" uuid[] NOT NULL,
	"event_ids" uuid[] NOT NULL,
	"durations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cells" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_events" DROP CONSTRAINT "lesson_events_batch_id_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "lesson_stages" DROP CONSTRAINT "lesson_stages_batch_id_batches_id_fk";
--> statement-breakpoint
DROP INDEX "lesson_events_batch_name_uq";--> statement-breakpoint
DROP INDEX "lesson_events_batch_idx";--> statement-breakpoint
DROP INDEX "lesson_stages_batch_name_uq";--> statement-breakpoint
DROP INDEX "lesson_stages_batch_idx";--> statement-breakpoint
ALTER TABLE "lesson_events" ALTER COLUMN "batch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_stages" ALTER COLUMN "batch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_plans" ADD COLUMN "durations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_plans" ADD COLUMN "focus" text;--> statement-breakpoint
ALTER TABLE "lesson_stages" ADD COLUMN "duration_min" integer;--> statement-breakpoint
ALTER TABLE "lesson_plan_templates" ADD CONSTRAINT "lesson_plan_templates_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_plan_templates_coach_name_uq" ON "lesson_plan_templates" USING btree ("coach_id",lower("name"));--> statement-breakpoint
UPDATE "lesson_stages" SET
  "duration_min" = substring("name" from '(?i)(\d+)\s*(?:mins?|minutes?)\M')::int,
  "name" = btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace("name", '[(\[]?\s*\d+\s*(?:mins?|minutes?)\M\s*[)\]]?', ' ', 'gi'),
        '\s+', ' ', 'g'
      ),
      '^[\s\-–:·|]+|[\s\-–:·|]+$', '', 'g'
    )
  )
WHERE "name" ~* '\d+\s*(?:mins?|minutes?)\M'
  AND btrim(regexp_replace("name", '[(\[]?\s*\d+\s*(?:mins?|minutes?)\M\s*[)\]]?', '', 'gi'), ' -–:·|') <> '';
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_stages"
  ) "m" WHERE "id" <> "keep"
)
DELETE FROM "lesson_plan_cells" "c" USING "d"
WHERE "c"."stage_id" = "d"."id" AND EXISTS (
  SELECT 1 FROM "lesson_plan_cells" "o"
  WHERE "o"."plan_id" = "c"."plan_id" AND "o"."stage_id" = "d"."keep"
    AND "o"."event_id" = "c"."event_id"
);
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_stages"
  ) "m" WHERE "id" <> "keep"
)
UPDATE "lesson_plan_cells" "c" SET "stage_id" = "d"."keep" FROM "d" WHERE "c"."stage_id" = "d"."id";
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_stages"
  ) "m" WHERE "id" <> "keep"
)
UPDATE "lesson_plans" "p" SET "stage_ids" = ARRAY(
  SELECT "x" FROM (
    SELECT coalesce("d"."keep", "u"."x") AS "x", min("u"."o") AS "o"
    FROM unnest("p"."stage_ids") WITH ORDINALITY AS "u"("x", "o")
    LEFT JOIN "d" ON "d"."id" = "u"."x"
    GROUP BY 1
  ) "t" ORDER BY "t"."o"
)
WHERE "p"."stage_ids" && ARRAY(SELECT "id" FROM "d");
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_stages"
  ) "m" WHERE "id" <> "keep"
)
DELETE FROM "lesson_stages" "t" USING "d" WHERE "t"."id" = "d"."id";
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_events"
  ) "m" WHERE "id" <> "keep"
)
DELETE FROM "lesson_plan_cells" "c" USING "d"
WHERE "c"."event_id" = "d"."id" AND EXISTS (
  SELECT 1 FROM "lesson_plan_cells" "o"
  WHERE "o"."plan_id" = "c"."plan_id" AND "o"."event_id" = "d"."keep"
    AND "o"."stage_id" = "c"."stage_id"
);
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_events"
  ) "m" WHERE "id" <> "keep"
)
UPDATE "lesson_plan_cells" "c" SET "event_id" = "d"."keep" FROM "d" WHERE "c"."event_id" = "d"."id";
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_events"
  ) "m" WHERE "id" <> "keep"
)
UPDATE "lesson_plans" "p" SET "event_ids" = ARRAY(
  SELECT "x" FROM (
    SELECT coalesce("d"."keep", "u"."x") AS "x", min("u"."o") AS "o"
    FROM unnest("p"."event_ids") WITH ORDINALITY AS "u"("x", "o")
    LEFT JOIN "d" ON "d"."id" = "u"."x"
    GROUP BY 1
  ) "t" ORDER BY "t"."o"
)
WHERE "p"."event_ids" && ARRAY(SELECT "id" FROM "d");
--> statement-breakpoint
WITH "d" AS (
  SELECT "id", "keep" FROM (
    SELECT "id", first_value("id") OVER (
      PARTITION BY "coach_id", lower("name") ORDER BY "is_archived", "created_at", "id"
    ) AS "keep" FROM "lesson_events"
  ) "m" WHERE "id" <> "keep"
)
DELETE FROM "lesson_events" "t" USING "d" WHERE "t"."id" = "d"."id";
--> statement-breakpoint
ALTER TABLE "lesson_events" ADD CONSTRAINT "lesson_events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_stages" ADD CONSTRAINT "lesson_stages_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_events_coach_name_uq" ON "lesson_events" USING btree ("coach_id",lower("name"));--> statement-breakpoint
CREATE INDEX "lesson_events_coach_idx" ON "lesson_events" USING btree ("coach_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_stages_coach_name_uq" ON "lesson_stages" USING btree ("coach_id",lower("name"));--> statement-breakpoint
CREATE INDEX "lesson_stages_coach_idx" ON "lesson_stages" USING btree ("coach_id","sort_order");