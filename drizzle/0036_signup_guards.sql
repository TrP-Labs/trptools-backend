-- Serialize staff reservations across web, bot and host writes on both runtimes.
-- Identity-only adoption intentionally preserves previously separate commitments.
CREATE FUNCTION enforce_signup_reservation() RETURNS trigger AS $$
DECLARE
    slot_capacity integer;
    actor_user uuid;
    actor_discord text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'signup:' || NEW.event_id::text || ':' || extract(epoch FROM NEW.occurrence)::text, 0));

    SELECT capacity INTO slot_capacity FROM signup_slots WHERE id = NEW.slot_id;
    IF (SELECT count(*) FROM shift_signups
        WHERE event_id = NEW.event_id AND occurrence = NEW.occurrence
        AND slot_id = NEW.slot_id AND id <> NEW.id) >= slot_capacity THEN
        RAISE EXCEPTION 'signup slot full' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        actor_user := coalesce(NEW.user_id, (SELECT id FROM users WHERE discord_id = NEW.discord_user_id));
        actor_discord := coalesce(NEW.discord_user_id, (SELECT discord_id FROM users WHERE id = NEW.user_id));
        IF EXISTS (SELECT 1 FROM shift_signups
            WHERE event_id = NEW.event_id AND occurrence = NEW.occurrence
            AND (user_id = actor_user OR discord_user_id = actor_discord)) THEN
            RAISE EXCEPTION 'signup already held' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER shift_signup_reservation BEFORE INSERT OR UPDATE OF slot_id, event_id, occurrence
ON shift_signups FOR EACH ROW EXECUTE FUNCTION enforce_signup_reservation();
