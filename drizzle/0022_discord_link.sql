ALTER TABLE "users" ADD COLUMN "discord_avatar" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "require_discord_for_signups" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "require_discord_for_applications" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD COLUMN "discord_id" text;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD COLUMN "discord_username" text;