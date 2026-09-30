CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"occurrence" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease" uuid,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint_hash" text NOT NULL,
	"subscription" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_hash_unique" UNIQUE("endpoint_hash")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "notification_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_watches" ADD CONSTRAINT "notification_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_watches" ADD CONSTRAINT "notification_watches_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_watches" ADD CONSTRAINT "notification_watches_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_unique" ON "notification_deliveries" USING btree ("subscription_id","event_id","occurrence");--> statement-breakpoint
CREATE INDEX "notification_delivery_due_idx" ON "notification_deliveries" USING btree ("available_at") WHERE "notification_deliveries"."delivered_at" is null AND "notification_deliveries"."attempts" < 5;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_watches_group_unique" ON "notification_watches" USING btree ("user_id","group_id") WHERE "notification_watches"."event_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_watches_event_unique" ON "notification_watches" USING btree ("user_id","event_id") WHERE "notification_watches"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_watches_group_idx" ON "notification_watches" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_notification_due_idx" ON "events" USING btree ("notification_at");--> statement-breakpoint
CREATE FUNCTION enforce_push_device_limit() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    IF (SELECT count(*) FROM push_subscriptions WHERE user_id = NEW.user_id AND id <> NEW.id AND endpoint_hash <> NEW.endpoint_hash) >= 10 THEN
        RAISE EXCEPTION 'push device limit' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER push_device_limit BEFORE INSERT OR UPDATE ON push_subscriptions
FOR EACH ROW EXECUTE FUNCTION enforce_push_device_limit();
--> statement-breakpoint
CREATE FUNCTION enforce_notification_watch_limit() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM notification_watches WHERE user_id = NEW.user_id AND group_id = NEW.group_id AND event_id IS NOT DISTINCT FROM NEW.event_id)
       AND (SELECT count(*) FROM notification_watches WHERE user_id = NEW.user_id) >= 200 THEN
        RAISE EXCEPTION 'notification watch limit' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER notification_watch_limit BEFORE INSERT ON notification_watches
FOR EACH ROW EXECUTE FUNCTION enforce_notification_watch_limit();
