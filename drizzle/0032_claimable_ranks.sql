CREATE TABLE "claimable_connections" (
	"group_id" uuid PRIMARY KEY NOT NULL,
	"authorized_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claimable_ranks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"rank_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"minimum_account_age_days" integer DEFAULT 0 NOT NULL,
	"require_discord" boolean DEFAULT false NOT NULL,
	"maximum_rank" integer NOT NULL,
	CONSTRAINT "claimable_ranks_group_slug_unique" UNIQUE("group_id","slug")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claimable_connections" ADD CONSTRAINT "claimable_connections_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimable_connections" ADD CONSTRAINT "claimable_connections_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimable_ranks" ADD CONSTRAINT "claimable_ranks_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimable_ranks" ADD CONSTRAINT "claimable_ranks_rank_id_rank_relations_id_fk" FOREIGN KEY ("rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE set null ON UPDATE no action;