ALTER TABLE "fee_plans" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "last_free_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plans_one_system_uq" ON "fee_plans" USING btree ("is_system") WHERE "fee_plans"."is_system";