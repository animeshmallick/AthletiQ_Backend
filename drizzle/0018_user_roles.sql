ALTER TABLE "sessions" ADD COLUMN "role" "user_role";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roles" "user_role"[];--> statement-breakpoint
UPDATE "users" SET "roles" = ARRAY["role"];--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "roles" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_uq" ON "users" USING btree ("phone");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_in_roles" CHECK ("users"."role" = any("users"."roles"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_roles_valid" CHECK (cardinality("users"."roles") between 1 and 2 and (cardinality("users"."roles") = 1 or "users"."roles"[1] <> "users"."roles"[2]));
