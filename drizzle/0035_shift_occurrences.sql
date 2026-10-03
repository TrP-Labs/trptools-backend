CREATE TABLE "shift_drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"roblox_id" text NOT NULL,
	"name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_drivers_person_unique" UNIQUE("occurrence_id","roblox_id")
);
--> statement-breakpoint
CREATE TABLE "shift_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"post_description" text DEFAULT '' NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" "visibility" DEFAULT 'PUBLIC' NOT NULL,
	"public_staff" boolean DEFAULT false NOT NULL,
	"public_drivers" boolean DEFAULT false NOT NULL,
	"on_demand" boolean DEFAULT false NOT NULL,
	"minimum_votes" integer DEFAULT 10 NOT NULL,
	"vote_opens_at" timestamp with time zone NOT NULL,
	"decision_at" timestamp with time zone NOT NULL,
	"minimum_rank" integer DEFAULT 0 NOT NULL,
	"vote_require_discord" boolean DEFAULT false NOT NULL,
	"website_voting" boolean DEFAULT true NOT NULL,
	"show_voters" boolean DEFAULT false NOT NULL,
	"decision" text DEFAULT 'SCHEDULED' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_occurrences_event_start_unique" UNIQUE("event_id","start")
);
--> statement-breakpoint
CREATE TABLE "shift_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"identity" text NOT NULL,
	"user_id" uuid,
	"discord_user_id" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_votes_identity_unique" UNIQUE("occurrence_id","identity")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "on_demand" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "minimum_votes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "vote_lead_minutes" integer DEFAULT 2880 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "decision_lead_minutes" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "minimum_rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "vote_require_discord" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "website_voting" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "show_voters" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "post_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "public_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "public_drivers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_drivers" ADD CONSTRAINT "shift_drivers_occurrence_id_shift_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."shift_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_occurrences" ADD CONSTRAINT "shift_occurrences_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_occurrences" ADD CONSTRAINT "shift_occurrences_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_votes" ADD CONSTRAINT "shift_votes_occurrence_id_shift_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."shift_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_votes" ADD CONSTRAINT "shift_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_occurrences_group_start_idx" ON "shift_occurrences" USING btree ("group_id","start");
--> statement-breakpoint
ALTER TABLE "shift_votes" ADD COLUMN "attending" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE "shift_staff_log" (
	"signup_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"occurrence" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"slot" text NOT NULL,
	"status" text DEFAULT 'SIGNED_UP' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shift_staff_log" ADD CONSTRAINT "shift_staff_log_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_staff_log_occurrence_idx" ON "shift_staff_log" USING btree ("event_id","occurrence");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_shift_vote(p_id uuid, p_identity text, p_user uuid, p_discord text, p_name text, p_attending boolean)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE shift shift_occurrences;
BEGIN
    SELECT * INTO shift FROM shift_occurrences WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR NOT shift.on_demand OR shift.decision <> 'PENDING' OR shift.decision_at <= clock_timestamp() THEN RETURN false; END IF;
    DELETE FROM shift_votes WHERE occurrence_id = p_id AND identity <> p_identity
        AND (user_id = p_user OR discord_user_id = p_discord);
    INSERT INTO shift_votes (occurrence_id, identity, user_id, discord_user_id, name, attending)
        VALUES (p_id, p_identity, p_user, p_discord, p_name, p_attending)
        ON CONFLICT (occurrence_id, identity) DO UPDATE SET attending = excluded.attending,
            name = excluded.name, user_id = excluded.user_id, discord_user_id = excluded.discord_user_id, created_at = clock_timestamp();
    RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION decide_shift(p_id uuid, p_now timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE shift shift_occurrences; votes integer;
BEGIN
    SELECT * INTO shift FROM shift_occurrences WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR NOT shift.on_demand OR shift.decision <> 'PENDING' OR shift.decision_at > p_now THEN RETURN; END IF;
    SELECT count(*) INTO votes FROM shift_votes WHERE occurrence_id = p_id AND attending;
    UPDATE shift_occurrences SET decision = CASE WHEN votes >= shift.minimum_votes THEN 'CONFIRMED' ELSE 'FAILED' END,
        decided_at = p_now WHERE id = p_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_shift_staff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person text; slot_name text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE shift_staff_log SET status = 'WITHDRAWN', updated_at = now() WHERE signup_id = OLD.id
            AND coalesce((SELECT "end" FROM shift_occurrences WHERE event_id = OLD.event_id AND start = OLD.occurrence),
                OLD.occurrence + (SELECT duration FROM events WHERE event_id = OLD.event_id) * interval '1 minute') > now();
        RETURN OLD;
    END IF;
    SELECT coalesce(cached_display_name, cached_username, roblox_id::text) INTO person FROM users WHERE id = NEW.user_id;
    SELECT name INTO slot_name FROM signup_slots WHERE id = NEW.slot_id;
    INSERT INTO shift_staff_log(signup_id, event_id, occurrence, name, slot, status)
        VALUES (NEW.id, NEW.event_id, NEW.occurrence, coalesce(person, NEW.discord_username, NEW.discord_user_id, 'Unknown'), coalesce(slot_name, 'Unknown'), 'SIGNED_UP')
        ON CONFLICT (signup_id) DO UPDATE SET name = excluded.name, slot = excluded.slot, status = 'SIGNED_UP', updated_at = now();
    RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shift_staff_history AFTER INSERT OR UPDATE OR DELETE ON shift_signups FOR EACH ROW EXECUTE FUNCTION record_shift_staff();
--> statement-breakpoint
INSERT INTO shift_staff_log (signup_id, event_id, occurrence, name, slot)
    SELECT s.id, s.event_id, s.occurrence, coalesce(u.cached_display_name, u.cached_username, s.discord_username, s.discord_user_id, 'Unknown'), slot.name
    FROM shift_signups s JOIN signup_slots slot ON slot.id = s.slot_id LEFT JOIN users u ON u.id = s.user_id;

--> statement-breakpoint
-- Existing sign-ups also get durable pages, including dates outside the current browse window.
INSERT INTO shift_occurrences(event_id, group_id, start, "end", name, slug, color, description, translations, visibility, vote_opens_at, decision_at)
    SELECT DISTINCT e.event_id, e.group_id, s.occurrence, s.occurrence + e.duration * interval '1 minute',
        e.name, e.slug, e.color, e.description, e.translations, e.visibility,
        s.occurrence - e.vote_lead_minutes * interval '1 minute', s.occurrence - e.decision_lead_minutes * interval '1 minute'
    FROM shift_signups s JOIN events e ON e.event_id = s.event_id
    ON CONFLICT (event_id, start) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION adopt_shift_votes(p_user uuid, p_discord text)
RETURNS TABLE(group_id uuid, event_id uuid, start timestamptz) LANGUAGE plpgsql AS $$
DECLARE shift shift_occurrences; vote shift_votes;
BEGIN
    FOR shift IN SELECT so.* FROM shift_occurrences so WHERE so.decision = 'PENDING'
        AND EXISTS (SELECT 1 FROM shift_votes v WHERE v.occurrence_id = so.id AND (v.user_id = p_user OR v.discord_user_id = p_discord))
        ORDER BY so.id FOR UPDATE
    LOOP
        SELECT * INTO vote FROM shift_votes v WHERE v.occurrence_id = shift.id AND (v.user_id = p_user OR v.discord_user_id = p_discord)
            ORDER BY v.created_at DESC, v.id DESC LIMIT 1;
        DELETE FROM shift_votes v WHERE v.occurrence_id = shift.id AND (v.user_id = p_user OR v.discord_user_id = p_discord);
        INSERT INTO shift_votes(occurrence_id, identity, user_id, discord_user_id, name, attending, created_at)
            VALUES(shift.id, 'discord:' || p_discord, p_user, p_discord, vote.name, vote.attending, vote.created_at);
        group_id := shift.group_id; event_id := shift.event_id; start := shift.start; RETURN NEXT;
    END LOOP;
END $$;

--> statement-breakpoint
-- Archived schedules retain history without consuming the active schedule allowance.
CREATE OR REPLACE FUNCTION enforce_group_shift_limit() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM groups WHERE id = NEW.group_id FOR UPDATE;
    IF (SELECT count(*) FROM events WHERE group_id = NEW.group_id AND NOT archived) >= 100 THEN
        RAISE EXCEPTION 'a group can have at most 100 shifts' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
