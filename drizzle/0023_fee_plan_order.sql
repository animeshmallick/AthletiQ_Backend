ALTER TABLE "fee_plans" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Keep the current order (days, then price) as the starting order.
UPDATE "fee_plans" p SET "sort_order" = o.rn FROM (SELECT id, row_number() OVER (ORDER BY "days_per_week", "monthly_fee", "name") - 1 AS rn FROM "fee_plans" WHERE NOT "is_system") o WHERE p.id = o.id;
