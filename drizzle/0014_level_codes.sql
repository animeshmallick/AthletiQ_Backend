-- Levels get a short code (A1…C2) and every sport moves to the standard ladder:
-- Beginner (A1 Novice, A2 Advanced Beginner), Intermediate (B1, B2), Advanced (C1, C2).
ALTER TABLE "skill_assessments" ADD COLUMN "level_code" text;--> statement-breakpoint
ALTER TABLE "sport_levels" ADD COLUMN "code" text;--> statement-breakpoint
DELETE FROM "sport_levels";--> statement-breakpoint
INSERT INTO "sport_levels" ("sport_id", "code", "name", "min_score", "position")
SELECT s."id", l.code, l.name, l.min_score, l.position
FROM "sports" s
CROSS JOIN (VALUES
  ('A1', 'Novice / Absolute Beginner', 100, 1),
  ('A2', 'Advanced Beginner', 175, 2),
  ('B1', 'Lower Intermediate', 250, 3),
  ('B2', 'Upper Intermediate', 325, 4),
  ('C1', 'Advanced / Regional Competitor', 400, 5),
  ('C2', 'Elite / National & International', 460, 6)
) AS l(code, name, min_score, position);--> statement-breakpoint
-- Re-level existing assessments on the new ladder (highest rung their average reaches).
UPDATE "skill_assessments" a SET
  "level_name" = l."name",
  "level_code" = l."code",
  "level_position" = l."position"
FROM "sport_levels" l
WHERE l."sport_id" = a."sport_id"
  AND l."position" = (
    SELECT max(l2."position") FROM "sport_levels" l2
    WHERE l2."sport_id" = a."sport_id" AND l2."min_score" <= a."average"
  );
