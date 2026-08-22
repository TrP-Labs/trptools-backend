ALTER TABLE "bot_configs" ADD COLUMN "announce_join_code" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "clear_signups" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "clear_announcements" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN "clear_host_reminders" boolean DEFAULT true NOT NULL;