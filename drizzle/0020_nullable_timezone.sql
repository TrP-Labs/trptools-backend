ALTER TABLE "users" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
-- Hand-added, and the reason the column was changed at all.
--
-- Every existing row says 'UTC' because that was the column default, so
-- leaving them would carry the bug forward: an account that never chose a zone
-- would go on stamping every application UTC, which is exactly what nulling
-- the column is meant to stop. Nobody is really in UTC — the United Kingdom is
-- Europe/London and Iceland is Atlantic/Reykjavik — so a stored 'UTC' is the
-- default nobody picked rather than a choice worth keeping.
UPDATE "users" SET "timezone" = NULL WHERE "timezone" = 'UTC';
