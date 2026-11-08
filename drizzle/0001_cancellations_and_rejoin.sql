CREATE TABLE "session_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"reason" text NOT NULL,
	"cancelled_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "billing_anchor_date" date;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "cycle_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD CONSTRAINT "session_cancellations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD CONSTRAINT "session_cancellations_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_cancellations_batch_date_uq" ON "session_cancellations" USING btree ("batch_id","date");