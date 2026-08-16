CREATE TABLE "rank_signup_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signup_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rank_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"name" text DEFAULT 'Staff' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"discord_channel" text,
	"discord_ping_role" text,
	CONSTRAINT "rank_signups_rank_id_unique" UNIQUE("rank_id")
);
--> statement-breakpoint
CREATE TABLE "shift_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"occurrence" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_signups_unique" UNIQUE("slot_id","event_id","occurrence","user_id")
);
--> statement-breakpoint
ALTER TABLE "rank_signup_slots" ADD CONSTRAINT "rank_signup_slots_signup_id_rank_signups_id_fk" FOREIGN KEY ("signup_id") REFERENCES "public"."rank_signups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_signups" ADD CONSTRAINT "rank_signups_rank_id_rank_relations_id_fk" FOREIGN KEY ("rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_slot_id_rank_signup_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."rank_signup_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rank_signup_slots_order_idx" ON "rank_signup_slots" USING btree ("signup_id","order");--> statement-breakpoint
CREATE INDEX "shift_signups_occurrence_idx" ON "shift_signups" USING btree ("event_id","occurrence");