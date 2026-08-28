CREATE TABLE "global_route_preferences" (
	"user_id" uuid NOT NULL,
	"route_name" text NOT NULL,
	"preference" "route_preference" NOT NULL,
	CONSTRAINT "global_route_preferences_user_id_route_name_pk" PRIMARY KEY("user_id","route_name")
);
--> statement-breakpoint
ALTER TABLE "global_route_preferences" ADD CONSTRAINT "global_route_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Marks already held against a built-in route become the global answer. A
-- driver who favourited route 6 in one group meant route 6, not that group's
-- copy of it, so the rows move rather than being dropped. Where the same
-- person answered differently in two groups, the favourite wins: the enum
-- orders FAVORITE before DISLIKE.
INSERT INTO "global_route_preferences" ("user_id", "route_name", "preference")
SELECT DISTINCT ON (rp."user_id", r."name") rp."user_id", r."name", rp."preference"
FROM "route_preferences" rp
JOIN "routes" r ON r."id" = rp."route_id"
WHERE r."built_in" = true
ORDER BY rp."user_id", r."name", rp."preference"
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "route_preferences" rp
USING "routes" r
WHERE r."id" = rp."route_id" AND r."built_in" = true;
