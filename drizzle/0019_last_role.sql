-- `role` only ever meant "the role they last signed in as" (the default next time); `roles` holds
-- every role. Rename it so the table says what it is. A plain rename: no data changes.
ALTER TABLE "users" RENAME COLUMN "role" TO "last_role";--> statement-breakpoint
ALTER INDEX "users_role_idx" RENAME TO "users_last_role_idx";--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "users_role_in_roles" TO "users_last_role_in_roles";
