ALTER TABLE "groups" ADD COLUMN "banner_media_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "room_open_lead_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "depots" ADD COLUMN "aliases" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "depots" ADD COLUMN "icon_media_id" uuid;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "icon_media_id" uuid;--> statement-breakpoint

--> statement-breakpoint
-- Routes, depots and shifts gained their own pages, addressed by a slug.
-- Existing rows have no slug yet, so each column arrives nullable, is filled
-- from the name the row already has, and only then becomes NOT NULL.
ALTER TABLE "depots" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "slug" text;--> statement-breakpoint

UPDATE "depots" SET "slug" = COALESCE(
    NULLIF(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''),
    'depot-' || "number"
) WHERE "slug" IS NULL;--> statement-breakpoint

-- A route named "9" would give an opaque /route/9, so bare numbers are
-- prefixed with their kind, matching how new slugs are generated.
UPDATE "routes" SET "slug" = CASE
    WHEN "name" ~ '^[0-9]+$' THEN 'route-' || "name"
    ELSE COALESCE(NULLIF(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'route')
END WHERE "slug" IS NULL;--> statement-breakpoint

UPDATE "events" SET "slug" = CASE
    WHEN "name" ~ '^[0-9]+$' THEN 'shift-' || "name"
    ELSE COALESCE(NULLIF(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'shift')
END WHERE "slug" IS NULL;--> statement-breakpoint

-- Two differently named rows can normalise to the same slug, and the unique
-- constraint below would then refuse to apply.
UPDATE "depots" d SET "slug" = d."slug" || '-' || substr(d."id"::text, 1, 8)
FROM (SELECT "group_id", "slug" FROM "depots" GROUP BY "group_id", "slug" HAVING count(*) > 1) dup
WHERE d."group_id" = dup."group_id" AND d."slug" = dup."slug";--> statement-breakpoint

UPDATE "routes" r SET "slug" = r."slug" || '-' || substr(r."id"::text, 1, 8)
FROM (SELECT "group_id", "slug" FROM "routes" GROUP BY "group_id", "slug" HAVING count(*) > 1) dup
WHERE r."group_id" = dup."group_id" AND r."slug" = dup."slug";--> statement-breakpoint

UPDATE "events" e SET "slug" = e."slug" || '-' || substr(e."event_id"::text, 1, 8)
FROM (SELECT "group_id", "slug" FROM "events" GROUP BY "group_id", "slug" HAVING count(*) > 1) dup
WHERE e."group_id" = dup."group_id" AND e."slug" = dup."slug";--> statement-breakpoint

ALTER TABLE "depots" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint

-- Cat Island answers to its old in-game name so saved vehicle lists still match.
UPDATE "depots" SET "aliases" = ARRAY['Hardbass Island']
WHERE "number" = 2 AND "name" = 'Cat Island' AND cardinality("aliases") = 0;--> statement-breakpoint

ALTER TABLE "depots" ADD CONSTRAINT "depots_group_slug_unique" UNIQUE("group_id","slug");--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_group_slug_unique" UNIQUE("group_id","slug");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_group_slug_unique" UNIQUE("group_id","slug");
