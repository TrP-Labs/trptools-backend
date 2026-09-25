-- Locking the group's row makes the count an exact cap even when two Workers
-- create objects at the same moment. The application checks first so ordinary
-- callers receive its translated 409 instead of a database exception.
CREATE FUNCTION enforce_group_shift_limit() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM groups WHERE id = NEW.group_id FOR UPDATE;
    IF (SELECT count(*) FROM events WHERE group_id = NEW.group_id) >= 100 THEN
        RAISE EXCEPTION 'a group can have at most 100 shifts' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER events_group_limit BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION enforce_group_shift_limit();--> statement-breakpoint

CREATE FUNCTION enforce_group_vehicle_rule_limit() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM groups WHERE id = NEW.group_id FOR UPDATE;
    IF (SELECT count(*) FROM vehicle_rules WHERE group_id = NEW.group_id) >= 100 THEN
        RAISE EXCEPTION 'a group can classify at most 100 vehicle models' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vehicle_rules_group_limit BEFORE INSERT ON vehicle_rules
FOR EACH ROW EXECUTE FUNCTION enforce_group_vehicle_rule_limit();
