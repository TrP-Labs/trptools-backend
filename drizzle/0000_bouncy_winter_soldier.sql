CREATE TYPE "public"."media_owner" AS ENUM('GROUP', 'ROUTE', 'DEPOT');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('VISIBLE', 'HIDDEN', 'APPROVED');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('OPEN', 'UPHELD', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."report_target" AS ENUM('GROUP', 'ROUTE', 'DEPOT', 'MEDIA');--> statement-breakpoint
CREATE TYPE "public"."route_preference" AS ENUM('FAVORITE', 'DISLIKE');--> statement-breakpoint
CREATE TYPE "public"."route_shape" AS ENUM('AUTO', 'CIRCLE', 'RECTANGLE', 'DIAMOND', 'HEXAGON');--> statement-breakpoint
CREATE TYPE "public"."vehicle_category" AS ENUM('TROLLEYBUS', 'SERVICE', 'STAFF', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('PUBLIC', 'UNLISTED', 'PRIVATE');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roblox_id" bigint NOT NULL,
	"site_rank" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cached_username" text,
	"cached_display_name" text,
	"cached_avatar" text,
	"cached_at" timestamp with time zone,
	"roblox_access_token" text,
	"roblox_refresh_token" text,
	"roblox_token_expires_at" timestamp with time zone,
	"roblox_scopes" text DEFAULT '' NOT NULL,
	"theme" text DEFAULT 'dim' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"profile_public" boolean DEFAULT true NOT NULL,
	CONSTRAINT "users_roblox_id_unique" UNIQUE("roblox_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"name" text DEFAULT 'API key' NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text DEFAULT 'groups:read routes:read schedule:read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"user_id" uuid NOT NULL,
	CONSTRAINT "api_keys_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "audit_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"actor_id" uuid,
	"date" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roblox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"visibility" "visibility" DEFAULT 'PRIVATE' NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"accent_color" text DEFAULT '#4287f5' NOT NULL,
	"banner_image" text,
	"show_routes" boolean DEFAULT true NOT NULL,
	"show_shifts" boolean DEFAULT true NOT NULL,
	"show_roster" boolean DEFAULT false NOT NULL,
	"show_dispatch" boolean DEFAULT false NOT NULL,
	"open_cloud_key" text,
	"cached_name" text,
	"cached_description" text,
	"cached_icon" text,
	"cached_members" integer,
	"cached_at" timestamp with time zone,
	"moderation" "moderation_status" DEFAULT 'VISIBLE' NOT NULL,
	CONSTRAINT "groups_roblox_id_unique" UNIQUE("roblox_id"),
	CONSTRAINT "groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rank_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"roblox_id" text NOT NULL,
	"color" text DEFAULT '#9b59b6' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"cached_name" text NOT NULL,
	"cached_rank" integer NOT NULL,
	"permission_level" integer DEFAULT 0 NOT NULL,
	"max_activity" integer,
	"min_activity" integer,
	CONSTRAINT "rank_relations_group_role_unique" UNIQUE("group_id","roblox_id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"category" "vehicle_category" DEFAULT 'OTHER' NOT NULL,
	"fixed_route" text,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"visibility" "visibility" DEFAULT 'PUBLIC' NOT NULL,
	"moderation" "moderation_status" DEFAULT 'VISIBLE' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "depots_group_number_unique" UNIQUE("group_id","number")
);
--> statement-breakpoint
CREATE TABLE "route_depots" (
	"route_id" uuid NOT NULL,
	"depot_id" uuid NOT NULL,
	CONSTRAINT "route_depots_route_id_depot_id_pk" PRIMARY KEY("route_id","depot_id")
);
--> statement-breakpoint
CREATE TABLE "route_preferences" (
	"user_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"preference" "route_preference" NOT NULL,
	CONSTRAINT "route_preferences_user_id_route_id_pk" PRIMARY KEY("user_id","route_id")
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"text_color" text DEFAULT '#111111' NOT NULL,
	"shape" "route_shape" DEFAULT 'AUTO' NOT NULL,
	"target_share" integer DEFAULT 20 NOT NULL,
	"auto_assign" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"visibility" "visibility" DEFAULT 'PUBLIC' NOT NULL,
	"moderation" "moderation_status" DEFAULT 'VISIBLE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_group_name_unique" UNIQUE("group_id","name")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"rrule" text NOT NULL,
	"duration" integer DEFAULT 120 NOT NULL,
	"visibility" "visibility" DEFAULT 'PUBLIC' NOT NULL,
	"host_level" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"occurrence" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_signups_unique" UNIQUE("slot_id","occurrence","user_id")
);
--> statement-breakpoint
CREATE TABLE "shift_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"announcement_channel" text,
	"poll_channel" text,
	"shift_ping_role" text,
	"owner_roblox_id" text,
	"place_id" text DEFAULT '2337102976' NOT NULL,
	CONSTRAINT "bot_configs_group_id_unique" UNIQUE("group_id"),
	CONSTRAINT "bot_configs_guild_id_unique" UNIQUE("guild_id")
);
--> statement-breakpoint
CREATE TABLE "staff_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"name" text DEFAULT 'Staff' NOT NULL,
	"announcement_channel" text NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"slots" text[] DEFAULT '{}' NOT NULL,
	"binded_rank_id" uuid NOT NULL,
	CONSTRAINT "staff_requests_binded_rank_id_unique" UNIQUE("binded_rank_id")
);
--> statement-breakpoint
CREATE TABLE "stage_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sound_id" text,
	"program" text NOT NULL,
	"visibility" "visibility" DEFAULT 'PRIVATE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_type" "media_owner" NOT NULL,
	"owner_id" uuid,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"moderation" "moderation_status" DEFAULT 'VISIBLE' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "report_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" "report_status" DEFAULT 'OPEN' NOT NULL,
	"reporter_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_messages" ADD CONSTRAINT "audit_messages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD CONSTRAINT "rank_relations_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_rules" ADD CONSTRAINT "vehicle_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depots" ADD CONSTRAINT "depots_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_depots" ADD CONSTRAINT "route_depots_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_depots" ADD CONSTRAINT "route_depots_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_preferences" ADD CONSTRAINT "route_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_preferences" ADD CONSTRAINT "route_preferences_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_slot_id_shift_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."shift_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_slots" ADD CONSTRAINT "shift_slots_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_requests" ADD CONSTRAINT "staff_requests_parent_id_bot_configs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."bot_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_requests" ADD CONSTRAINT "staff_requests_binded_rank_id_rank_relations_id_fk" FOREIGN KEY ("binded_rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_programs" ADD CONSTRAINT "stage_programs_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_cached_username_idx" ON "users" USING btree ("cached_username");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_group_date_idx" ON "audit_messages" USING btree ("group_id","date");--> statement-breakpoint
CREATE INDEX "groups_visibility_idx" ON "groups" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "rank_relations_roblox_idx" ON "rank_relations" USING btree ("roblox_id");--> statement-breakpoint
CREATE INDEX "vehicle_rules_group_order_idx" ON "vehicle_rules" USING btree ("group_id","order");--> statement-breakpoint
CREATE INDEX "depots_group_idx" ON "depots" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "route_preferences_route_idx" ON "route_preferences" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "routes_group_archived_idx" ON "routes" USING btree ("group_id","archived");--> statement-breakpoint
CREATE INDEX "events_group_idx" ON "events" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "shift_signups_occurrence_idx" ON "shift_signups" USING btree ("occurrence");--> statement-breakpoint
CREATE INDEX "shift_slots_event_order_idx" ON "shift_slots" USING btree ("event_id","order");--> statement-breakpoint
CREATE INDEX "stage_programs_author_idx" ON "stage_programs" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "stage_programs_visibility_idx" ON "stage_programs" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "media_group_idx" ON "media" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_target_idx" ON "reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_id");