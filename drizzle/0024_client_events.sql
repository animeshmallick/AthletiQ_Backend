CREATE TABLE "client_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"screen" text,
	"app_version" text,
	"platform" text NOT NULL,
	"user_agent" text,
	"online" boolean,
	"count" integer DEFAULT 1 NOT NULL,
	"details" jsonb,
	"user_id" uuid,
	"role" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_events" ADD CONSTRAINT "client_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_events_occurred_idx" ON "client_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "client_events_fingerprint_idx" ON "client_events" USING btree ("fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "client_events_user_idx" ON "client_events" USING btree ("user_id","occurred_at");