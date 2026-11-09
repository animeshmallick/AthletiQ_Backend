CREATE TYPE "public"."fund_account" AS ENUM('cash', 'academy_fund', 'staff_due', 'payee_due');--> statement-breakpoint
CREATE TYPE "public"."fund_txn_type" AS ENUM('fee_split', 'handover', 'expense', 'payout', 'income');--> statement-breakpoint
CREATE TYPE "public"."split_kind" AS ENUM('percent', 'flat');--> statement-breakpoint
CREATE TYPE "public"."split_recipient" AS ENUM('academy', 'batch_coach', 'staff', 'payee');--> statement-breakpoint
CREATE TABLE "fee_plan_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fee_plan_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	"kind" "split_kind" NOT NULL,
	"value" integer NOT NULL,
	"recipient" "split_recipient",
	"user_id" uuid,
	"payee_id" uuid,
	CONSTRAINT "fee_plan_splits_value_chk" CHECK ("fee_plan_splits"."value" > 0)
);
--> statement-breakpoint
CREATE TABLE "fund_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"txn_id" uuid NOT NULL,
	"account" "fund_account" NOT NULL,
	"user_id" uuid,
	"payee_id" uuid,
	"amount" integer NOT NULL,
	"label" text,
	"share" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fund_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "fund_txn_type" NOT NULL,
	"occurred_on" date NOT NULL,
	"amount" integer NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"note" text,
	"reference" text,
	"payment_id" uuid,
	"user_id" uuid,
	"payee_id" uuid,
	"created_by_id" uuid NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fund_txns_amount_chk" CHECK ("fund_txns"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_plan_splits" ADD CONSTRAINT "fee_plan_splits_fee_plan_id_fee_plans_id_fk" FOREIGN KEY ("fee_plan_id") REFERENCES "public"."fee_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan_splits" ADD CONSTRAINT "fee_plan_splits_parent_id_fee_plan_splits_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."fee_plan_splits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan_splits" ADD CONSTRAINT "fee_plan_splits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan_splits" ADD CONSTRAINT "fee_plan_splits_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_txn_id_fund_txns_id_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."fund_txns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_txns" ADD CONSTRAINT "fund_txns_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_txns" ADD CONSTRAINT "fund_txns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_txns" ADD CONSTRAINT "fund_txns_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_txns" ADD CONSTRAINT "fund_txns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_txns" ADD CONSTRAINT "fund_txns_reversed_by_id_users_id_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_plan_splits_plan_idx" ON "fee_plan_splits" USING btree ("fee_plan_id");--> statement-breakpoint
CREATE INDEX "fund_entries_txn_idx" ON "fund_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "fund_entries_account_idx" ON "fund_entries" USING btree ("account","user_id");--> statement-breakpoint
CREATE INDEX "fund_txns_occurred_idx" ON "fund_txns" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "fund_txns_user_idx" ON "fund_txns" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fund_txns_one_split_per_payment_uq" ON "fund_txns" USING btree ("payment_id") WHERE "fund_txns"."reversed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payees_name_lower_uq" ON "payees" USING btree (lower("name"));--> statement-breakpoint
-- Backfill: every completed payment becomes a fee split with 100% to the academy (no plan had a
-- split yet). Cash stays with the coach who collected it, or with the academy if an admin did.
INSERT INTO "fund_txns" ("type", "occurred_on", "amount", "title", "payment_id", "user_id", "created_by_id")
SELECT 'fee_split', p."paid_on", p."amount", 'Fee · ' || i."number" || ' · ' || s."full_name", p."id", p."recorded_by_id", p."recorded_by_id"
FROM "payments" p
JOIN "invoices" i ON i."id" = p."invoice_id"
JOIN "students" s ON s."id" = i."student_id"
WHERE p."status" = 'completed';--> statement-breakpoint
INSERT INTO "fund_entries" ("txn_id", "account", "user_id", "amount")
SELECT t."id", 'cash', CASE WHEN u."role" = 'coach' THEN u."id" END, t."amount"
FROM "fund_txns" t JOIN "users" u ON u."id" = t."user_id"
WHERE t."type" = 'fee_split';--> statement-breakpoint
INSERT INTO "fund_entries" ("txn_id", "account", "amount", "label", "share")
SELECT t."id", 'academy_fund', t."amount", 'Academy', true
FROM "fund_txns" t
WHERE t."type" = 'fee_split';
