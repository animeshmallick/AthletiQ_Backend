CREATE TABLE "server_health" (
	"at" timestamp with time zone NOT NULL,
	"cpu" real NOT NULL,
	"steal" real NOT NULL,
	"load" real NOT NULL,
	"mem_total" integer NOT NULL,
	"mem_used" integer NOT NULL,
	"swap_total" integer NOT NULL,
	"swap_used" integer NOT NULL,
	"disk_total" integer NOT NULL,
	"disk_used" integer NOT NULL,
	"disk_free" integer NOT NULL,
	"app_mem" integer NOT NULL,
	"app_limit" integer,
	"lag_ms" integer NOT NULL,
	"db_ms" integer,
	"db_connections" integer NOT NULL,
	"db_waiting" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "server_health_at_idx" ON "server_health" USING btree ("at");