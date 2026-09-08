ALTER TABLE "rank_relations" ADD COLUMN "permissions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Every rank keeps exactly what it could already do. The numbers are the
-- presets in `utils/permissions.ts`: 3 = dashboard + dispatch, 271 = those
-- plus opening rooms, editing shifts and reviewing applicants, 65535 =
-- administrator, which is what "manage" has always meant.
UPDATE "rank_relations" SET "permissions" = CASE
    WHEN "cached_rank" >= 255 THEN 65535
    WHEN "permission_level" >= 3 THEN 65535
    WHEN "permission_level" = 2 THEN 271
    WHEN "permission_level" = 1 THEN 3
    ELSE 0
END;
