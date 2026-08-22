-- The place a group runs shifts in is no longer configurable: there is one,
-- and the bot page offered a text box for it only because the legacy TOML did.
-- Any row that was pointed somewhere else comes back in line here, so the
-- column agrees with the schema default that every new row already gets.
UPDATE "bot_configs" SET "place_id" = '2337102976' WHERE "place_id" <> '2337102976';
