CREATE SEQUENCE "public"."student_registration_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "sports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_link_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"sport_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"coach_id" uuid NOT NULL,
	"month" date NOT NULL,
	"average" smallint NOT NULL,
	"level_name" text,
	"level_position" smallint,
	"comment" text,
	"goals" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_assessments_month_chk" CHECK (extract(day from "skill_assessments"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "skill_ratings" (
	"assessment_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	CONSTRAINT "skill_ratings_assessment_id_skill_id_pk" PRIMARY KEY("assessment_id","skill_id"),
	CONSTRAINT "skill_ratings_rating_chk" CHECK ("skill_ratings"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sport_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_score" smallint NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sport_levels_min_chk" CHECK ("sport_levels"."min_score" between 100 and 500)
);
--> statement-breakpoint
CREATE TABLE "student_photos" (
	"student_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_links" ADD CONSTRAINT "report_links_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_links" ADD CONSTRAINT "report_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_areas" ADD CONSTRAINT "skill_areas_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_ratings" ADD CONSTRAINT "skill_ratings_assessment_id_skill_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."skill_assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_ratings" ADD CONSTRAINT "skill_ratings_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_area_id_skill_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."skill_areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sport_levels" ADD CONSTRAINT "sport_levels_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_photos" ADD CONSTRAINT "student_photos_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sports_name_lower_uq" ON "sports" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "report_links_token_uq" ON "report_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "report_links_student_idx" ON "report_links" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "skill_areas_sport_idx" ON "skill_areas" USING btree ("sport_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_assessments_student_batch_month_uq" ON "skill_assessments" USING btree ("student_id","batch_id","month");--> statement-breakpoint
CREATE INDEX "skill_assessments_batch_month_idx" ON "skill_assessments" USING btree ("batch_id","month");--> statement-breakpoint
CREATE INDEX "skill_ratings_skill_idx" ON "skill_ratings" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skills_area_idx" ON "skills" USING btree ("area_id","position");--> statement-breakpoint
CREATE INDEX "sport_levels_sport_idx" ON "sport_levels" USING btree ("sport_id","position");--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "sport_id" uuid;--> statement-breakpoint
-- A ready-made Badminton framework (admins can edit it); existing batches train badminton.
DO $$
DECLARE
  sport uuid;
  area uuid;
  a record;
  s text;
  i int;
BEGIN
  INSERT INTO "sports" ("name") VALUES ('Badminton') RETURNING "id" INTO sport;
  FOR a IN
    SELECT * FROM (VALUES
      (1, 'Footwork', ARRAY['Split step and ready position', 'Court coverage (front and back)', 'Recovery to base', 'Speed and agility']),
      (2, 'Strokes', ARRAY['Forehand clear', 'Backhand clear', 'Drop shot', 'Smash', 'Net shots', 'Drive']),
      (3, 'Serve and return', ARRAY['Low serve', 'High serve', 'Flick serve', 'Return of serve']),
      (4, 'Defence', ARRAY['Smash defence', 'Block and lift', 'Body position and balance']),
      (5, 'Fitness', ARRAY['Stamina', 'Strength and core', 'Flexibility']),
      (6, 'Game sense', ARRAY['Shot selection', 'Rally building', 'Doubles rotation', 'Focus and attitude'])
    ) AS t(pos, name, list)
  LOOP
    INSERT INTO "skill_areas" ("sport_id", "name", "position") VALUES (sport, a.name, a.pos)
      RETURNING "id" INTO area;
    i := 0;
    FOREACH s IN ARRAY a.list LOOP
      i := i + 1;
      INSERT INTO "skills" ("area_id", "name", "position") VALUES (area, s, i);
    END LOOP;
  END LOOP;
  INSERT INTO "sport_levels" ("sport_id", "name", "min_score", "position") VALUES
    (sport, 'Foundation', 100, 1),
    (sport, 'Bronze', 200, 2),
    (sport, 'Silver', 275, 3),
    (sport, 'Gold', 350, 4),
    (sport, 'Elite', 425, 5);
  UPDATE "batches" SET "sport_id" = sport;
END $$;--> statement-breakpoint
ALTER TABLE "batches" ALTER COLUMN "sport_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "registration_no" integer;--> statement-breakpoint
-- Existing students get 1001, 1002, … in the order they were added.
UPDATE "students" s SET "registration_no" = n.no
FROM (
  SELECT "id", 1000 + row_number() OVER (ORDER BY "created_at", "code") AS no FROM "students"
) n
WHERE n."id" = s."id";--> statement-breakpoint
SELECT setval('student_registration_seq', COALESCE((SELECT max("registration_no") FROM "students"), 1000) + 1, false);--> statement-breakpoint
ALTER TABLE "students" ALTER COLUMN "registration_no" SET DEFAULT nextval('student_registration_seq');--> statement-breakpoint
ALTER TABLE "students" ALTER COLUMN "registration_no" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_registration_no_uq" ON "students" USING btree ("registration_no");
