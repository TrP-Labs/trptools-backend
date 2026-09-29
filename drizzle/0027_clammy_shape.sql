CREATE TABLE "group_follows" (
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_follows_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "group_follows" ADD CONSTRAINT "group_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_follows" ADD CONSTRAINT "group_follows_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_follows_group_idx" ON "group_follows" USING btree ("group_id");--> statement-breakpoint
CREATE FUNCTION enforce_follow_limit() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM group_follows WHERE user_id = NEW.user_id AND group_id = NEW.group_id)
       AND (SELECT count(*) FROM group_follows WHERE user_id = NEW.user_id) >= 100 THEN
        RAISE EXCEPTION 'follow limit' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER group_follows_limit BEFORE INSERT ON group_follows
FOR EACH ROW EXECUTE FUNCTION enforce_follow_limit();
