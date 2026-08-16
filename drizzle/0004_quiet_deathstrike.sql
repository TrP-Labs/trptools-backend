ALTER TABLE "shift_signups" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shift_slots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_requests" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "shift_signups" CASCADE;--> statement-breakpoint
DROP TABLE "shift_slots" CASCADE;--> statement-breakpoint
DROP TABLE "staff_requests" CASCADE;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "cached_guild_name" text;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "cached_guild_icon" text;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "cached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "installed_by" uuid;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "installed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "host_channel" text;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "host_ping_role" text;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "announcements_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "signups_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "polls_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "reminders_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "manifest_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_announce" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_announce_lead" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_signups" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_signups_lead" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_host_reminder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_host_reminder_lead" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_begin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_begin_lead" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "auto_complete_delay" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "manifest_refresh_seconds" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;