ALTER TABLE "users" ADD COLUMN "instant_redirects" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "discord_invite" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "roblox_join_enabled" boolean DEFAULT true NOT NULL;