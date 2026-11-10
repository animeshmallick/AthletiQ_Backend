CREATE TABLE "batch_plan_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"minutes" integer NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_plan_blocks_minutes_chk" CHECK ("batch_plan_blocks"."minutes" between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "batch_plan_drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"name" text NOT NULL,
	"minutes" integer,
	"reps" text,
	"note" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"focus" text,
	"notes" text,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"coach_id" uuid,
	"blocks" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_plan_blocks" ADD CONSTRAINT "batch_plan_blocks_plan_id_batch_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."batch_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_plan_drills" ADD CONSTRAINT "batch_plan_drills_block_id_batch_plan_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."batch_plan_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_plans" ADD CONSTRAINT "batch_plans_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_plans" ADD CONSTRAINT "batch_plans_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_plans" ADD CONSTRAINT "session_plans_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_plans" ADD CONSTRAINT "session_plans_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_plan_blocks_plan_idx" ON "batch_plan_blocks" USING btree ("plan_id","sort_order");--> statement-breakpoint
CREATE INDEX "batch_plan_drills_block_idx" ON "batch_plan_drills" USING btree ("block_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_plans_batch_uq" ON "batch_plans" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_plans_batch_date_uq" ON "session_plans" USING btree ("batch_id","date");