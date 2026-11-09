-- Fee split sections are named only after who finally receives the money: divided sections
-- have no name of their own, and share lines drop the "Parent › " prefix.
UPDATE "fee_plan_splits" s SET "name" = ''
WHERE EXISTS (SELECT 1 FROM "fee_plan_splits" c WHERE c."parent_id" = s."id");--> statement-breakpoint
UPDATE "fund_entries" SET "label" = regexp_replace("label", '^.* › ', '')
WHERE "label" LIKE '% › %';
