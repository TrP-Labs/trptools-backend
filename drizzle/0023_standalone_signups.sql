-- Sign-up sheets stop being a property of a rank and become objects of their
-- own, with an explicit list of the ranks that may fill each slot.
--
-- Nobody's access changes. A sheet used to be readable by the rank it hung off
-- and *every rank above it*, so the list each sheet is seeded with is exactly
-- that set, expanded at migration time. A group that never opens the new
-- editor keeps the sheets it had, in the order it had them, open to the same
-- people.
ALTER TABLE "rank_signups" RENAME TO "signup_sheets";--> statement-breakpoint
ALTER TABLE "rank_signup_slots" RENAME TO "signup_slots";--> statement-breakpoint
ALTER TABLE "signup_slots" RENAME COLUMN "signup_id" TO "sheet_id";--> statement-breakpoint
ALTER INDEX "rank_signup_slots_order_idx" RENAME TO "signup_slots_order_idx";--> statement-breakpoint

-- The constraint names travel with the tables, or a migrated instance and a
-- freshly installed one disagree about what everything is called and the next
-- `drizzle-kit generate` sees a difference that is not one.
ALTER TABLE "signup_sheets" RENAME CONSTRAINT "rank_signups_pkey" TO "signup_sheets_pkey";--> statement-breakpoint
ALTER TABLE "signup_slots" RENAME CONSTRAINT "rank_signup_slots_pkey" TO "signup_slots_pkey";--> statement-breakpoint
ALTER TABLE "signup_slots" RENAME CONSTRAINT "rank_signup_slots_signup_id_rank_signups_id_fk"
    TO "signup_slots_sheet_id_signup_sheets_id_fk";--> statement-breakpoint
ALTER TABLE "shift_signups" RENAME CONSTRAINT "shift_signups_slot_id_rank_signup_slots_id_fk"
    TO "shift_signups_slot_id_signup_slots_id_fk";--> statement-breakpoint

ALTER TABLE "signup_sheets" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "signup_sheets" ADD COLUMN "uniform_ranks" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "signup_sheets" ADD COLUMN "order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "signup_sheets" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- The group comes from the rank the sheet hung off, and so does the order:
-- sheets sorted themselves highest rank first, so inverting the rank number
-- reproduces exactly the order groups are used to seeing.
UPDATE "signup_sheets" AS s
SET "group_id" = r."group_id",
    "order" = 255 - LEAST(GREATEST(r."cached_rank", 0), 255)
FROM "rank_relations" AS r
WHERE s."rank_id" = r."id";--> statement-breakpoint

-- `rank_id` was NOT NULL with a cascade, so this can only match a row left by
-- a half-applied earlier migration. Dropping it is safer than a NOT NULL that
-- fails the whole upgrade on one orphan.
DELETE FROM "signup_sheets" WHERE "group_id" IS NULL;--> statement-breakpoint

ALTER TABLE "signup_sheets" ALTER COLUMN "group_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "signup_sheets" ADD CONSTRAINT "signup_sheets_group_id_groups_id_fk"
    FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signup_sheets_group_idx" ON "signup_sheets" USING btree ("group_id","order");--> statement-breakpoint

CREATE TABLE "signup_sheet_ranks" (
    "sheet_id" uuid NOT NULL,
    "rank_id" uuid NOT NULL,
    CONSTRAINT "signup_sheet_ranks_sheet_id_rank_id_pk" PRIMARY KEY("sheet_id","rank_id")
);--> statement-breakpoint
CREATE TABLE "signup_slot_ranks" (
    "slot_id" uuid NOT NULL,
    "rank_id" uuid NOT NULL,
    CONSTRAINT "signup_slot_ranks_slot_id_rank_id_pk" PRIMARY KEY("slot_id","rank_id")
);--> statement-breakpoint

ALTER TABLE "signup_sheet_ranks" ADD CONSTRAINT "signup_sheet_ranks_sheet_id_signup_sheets_id_fk"
    FOREIGN KEY ("sheet_id") REFERENCES "public"."signup_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_sheet_ranks" ADD CONSTRAINT "signup_sheet_ranks_rank_id_rank_relations_id_fk"
    FOREIGN KEY ("rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_slot_ranks" ADD CONSTRAINT "signup_slot_ranks_slot_id_signup_slots_id_fk"
    FOREIGN KEY ("slot_id") REFERENCES "public"."signup_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_slot_ranks" ADD CONSTRAINT "signup_slot_ranks_rank_id_rank_relations_id_fk"
    FOREIGN KEY ("rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The old rule, written out: the rank the sheet hung off and every rank at or
-- above it, within the same group. An empty list would have meant something
-- else entirely — every member — so every migrated sheet gets a real list.
INSERT INTO "signup_sheet_ranks" ("sheet_id", "rank_id")
SELECT s."id", above."id"
FROM "signup_sheets" AS s
JOIN "rank_relations" AS origin ON origin."id" = s."rank_id"
JOIN "rank_relations" AS above
    ON above."group_id" = origin."group_id" AND above."cached_rank" >= origin."cached_rank"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Each slot's own list starts as a copy of the sheet's, so a group that turns
-- "every slot the same" off begins from what was already true rather than from
-- an empty list that would silently open every slot to the whole group.
INSERT INTO "signup_slot_ranks" ("slot_id", "rank_id")
SELECT sl."id", sr."rank_id"
FROM "signup_slots" AS sl
JOIN "signup_sheet_ranks" AS sr ON sr."sheet_id" = sl."sheet_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint

ALTER TABLE "signup_sheets" DROP COLUMN "rank_id";--> statement-breakpoint

-- Three new grants (`utils/permissions.ts`), handed out so that nobody loses
-- something they could already do:
--   65536  MANAGE_SIGNUPS   — sheets lived under "manage ranks" until now
--   131072 OVERRIDE_SIGNUPS — sheet visibility answered yes to MANAGE_SHIFTS
--                             outright, so a host could already take any slot
-- EDIT_SIGNUPS (262144) is genuinely new: nobody could move or remove somebody
-- else's sign-up before, so it is granted to nobody. Administrators hold every
-- grant by definition (`has`), so none of this touches them.
UPDATE "rank_relations" SET "permissions" = "permissions" | 65536 WHERE ("permissions" & 64) = 64;--> statement-breakpoint
UPDATE "rank_relations" SET "permissions" = "permissions" | 131072 WHERE ("permissions" & 8) = 8;
