ALTER TABLE "users" ADD COLUMN "roblox_write_access_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_write_refresh_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_write_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_write_scopes" text DEFAULT '' NOT NULL;