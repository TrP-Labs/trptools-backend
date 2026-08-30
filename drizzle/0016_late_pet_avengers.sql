ALTER TABLE "users" ADD COLUMN "primary_group_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "admin_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_primary_group_id_groups_id_fk" FOREIGN KEY ("primary_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;