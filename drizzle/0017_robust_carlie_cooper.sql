ALTER TABLE "users" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" DROP NOT NULL;--> statement-breakpoint
-- Every row holds 'en' because that was the column default, not because
-- anybody chose English: the picker renders the locales the frontend ships,
-- and it has only ever shipped one. Left alone, those rows would read as a
-- deliberate choice, and the day a second language ships their owners would be
-- the only people still getting English while new accounts followed their
-- browser. Clearing them makes existing and new accounts behave the same.
--
-- This is safe only while one locale has shipped. Once there are two, a stored
-- tag may be a real choice and this must never be run again.
UPDATE "users" SET "locale" = NULL;
