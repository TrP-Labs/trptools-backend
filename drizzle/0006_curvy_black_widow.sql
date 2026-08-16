ALTER TABLE "shift_signups" DROP CONSTRAINT "shift_signups_unique";--> statement-breakpoint
ALTER TABLE "shift_signups" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_username" text;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD COLUMN "discord_user_id" text;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD COLUMN "discord_username" text;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_signups_user_unique" ON "shift_signups" USING btree ("slot_id","event_id","occurrence","user_id") WHERE "shift_signups"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_signups_discord_unique" ON "shift_signups" USING btree ("slot_id","event_id","occurrence","discord_user_id") WHERE "shift_signups"."discord_user_id" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id");