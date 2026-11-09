CREATE TABLE "api_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"code" text,
	"message" text,
	"user_id" uuid,
	"request_id" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_requests_created_idx" ON "api_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_requests_status_idx" ON "api_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "api_requests_user_idx" ON "api_requests" USING btree ("user_id","created_at");