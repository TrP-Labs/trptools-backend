import { relations, sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { groups, rankRelations } from './groups'
import { events } from './events'
import { users } from './users'
import { translations } from './translations'

/**
 * A sign-up sheet, belonging to the group rather than to a rank.
 *
 * Sheets used to hang off `rank_relations`, one per rank, and who could fill
 * one followed from Roblox's 0-255 ordering: the bound rank and everything
 * above it. That made a rank binding two decisions at once — what somebody may
 * *do* in the dashboard, and what they may sign up for on a Saturday — and a
 * group that wanted one sheet for two unrelated ranks had no way to say so.
 *
 * A sheet is now its own object with its own page, and eligibility is an
 * explicit list of ranks (`signup_sheet_ranks` / `signup_slot_ranks`) rather
 * than a threshold. `uniform_ranks` says which of the two lists is in force:
 * on, the sheet's own list applies to every slot, which is what almost every
 * group wants and so is the default.
 *
 * The Discord columns are optional. A group with no bot still gets working
 * sign-ups on the web.
 */
export const signupSheets = pgTable(
    'signup_sheets',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        enabled: boolean('enabled').notNull().default(false),
        name: text('name').notNull().default('Staff'),
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        color: text('color').notNull().default('#4287f5'),

        /**
         * Whether every slot shares the sheet's rank list.
         *
         * Both lists are stored either way, so turning this off and back on
         * does not throw away whichever one is not currently in force.
         */
        uniformRanks: boolean('uniform_ranks').notNull().default(true),

        /**
         * Where the sheet sits in the group's list.
         *
         * Sheets used to order themselves by the rank they hung off, highest
         * first. With no rank to sort by, the order is the group's to choose.
         */
        order: integer('order').notNull().default(0),

        /** Where the bot posts this sheet. Falls back to nothing, not to a default. */
        discordChannel: text('discord_channel'),
        /** Pinged when the sheet is posted. */
        discordPingRole: text('discord_ping_role'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [index('signup_sheets_group_idx').on(table.groupId, table.order)]
)

export const signupSlots = pgTable(
    'signup_slots',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        sheetId: uuid('sheet_id')
            .notNull()
            .references(() => signupSheets.id, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        capacity: integer('capacity').notNull().default(1),
        order: integer('order').notNull().default(0)
    },
    (table) => [index('signup_slots_order_idx').on(table.sheetId, table.order)]
)

/**
 * Which ranks may fill a sheet, when every slot shares one list.
 *
 * A join table rather than an array column because these are foreign keys: a
 * rank unbound from the group has to take its entries with it, or a sheet
 * would keep admitting a row nothing backs.
 *
 * **An empty list means every member of the group**, not nobody. A sheet is
 * created empty, and "nobody" would make a new sheet quietly unusable while
 * looking finished; a group that wants open sign-ups would otherwise have to
 * list every rank it has and remember to revisit the list on every binding.
 * The editor says so on the sheet rather than leaving it to be discovered.
 */
export const signupSheetRanks = pgTable(
    'signup_sheet_ranks',
    {
        sheetId: uuid('sheet_id')
            .notNull()
            .references(() => signupSheets.id, { onDelete: 'cascade' }),
        rankId: uuid('rank_id')
            .notNull()
            .references(() => rankRelations.id, { onDelete: 'cascade' })
    },
    (table) => [primaryKey({ columns: [table.sheetId, table.rankId] })]
)

/** The same list per slot, in force when a sheet's `uniformRanks` is off. */
export const signupSlotRanks = pgTable(
    'signup_slot_ranks',
    {
        slotId: uuid('slot_id')
            .notNull()
            .references(() => signupSlots.id, { onDelete: 'cascade' }),
        rankId: uuid('rank_id')
            .notNull()
            .references(() => rankRelations.id, { onDelete: 'cascade' })
    },
    (table) => [primaryKey({ columns: [table.slotId, table.rankId] })]
)

/**
 * One person taking one slot on one concrete occurrence of one shift.
 *
 * `eventId` is carried alongside the occurrence timestamp because slots are
 * shared across every shift — without it, two shifts starting at the same
 * moment would collide on the same slot.
 *
 * A signup identifies its taker one of two ways, and exactly one is set. Web
 * sign-ups carry `userId`. Sign-ups made from a Discord sheet carry
 * `discordUserId` instead, because the sheet lives in a channel their Discord
 * role already gates and demanding they register on the site first would make
 * the Discord half of the feature useless. When a Discord account is linked to
 * a TrPTools one the signup resolves to the real user, and both halves show
 * the same person.
 */
export const shiftSignups = pgTable(
    'shift_signups',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        slotId: uuid('slot_id')
            .notNull()
            .references(() => signupSlots.id, { onDelete: 'cascade' }),
        eventId: uuid('event_id')
            .notNull()
            .references(() => events.eventId, { onDelete: 'cascade' }),
        userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

        /** Set instead of `userId` for someone who signed up from Discord. */
        discordUserId: text('discord_user_id'),
        /** Their Discord display name, so the web can render them at all. */
        discordUsername: text('discord_username'),

        occurrence: timestamp('occurrence', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        // Two partial indexes rather than one constraint: Postgres treats NULLs
        // as distinct, so a single unique over both identity columns would let
        // the same person take a slot twice.
        uniqueIndex('shift_signups_user_unique')
            .on(table.slotId, table.eventId, table.occurrence, table.userId)
            .where(sql`${table.userId} is not null`),
        uniqueIndex('shift_signups_discord_unique')
            .on(table.slotId, table.eventId, table.occurrence, table.discordUserId)
            .where(sql`${table.discordUserId} is not null`),
        index('shift_signups_occurrence_idx').on(table.eventId, table.occurrence)
    ]
)

export const signupSheetsRelations = relations(signupSheets, ({ one, many }) => ({
    group: one(groups, { fields: [signupSheets.groupId], references: [groups.id] }),
    slots: many(signupSlots),
    ranks: many(signupSheetRanks)
}))

export const signupSlotsRelations = relations(signupSlots, ({ one, many }) => ({
    sheet: one(signupSheets, { fields: [signupSlots.sheetId], references: [signupSheets.id] }),
    ranks: many(signupSlotRanks),
    signups: many(shiftSignups)
}))

export const signupSheetRanksRelations = relations(signupSheetRanks, ({ one }) => ({
    sheet: one(signupSheets, { fields: [signupSheetRanks.sheetId], references: [signupSheets.id] }),
    rank: one(rankRelations, { fields: [signupSheetRanks.rankId], references: [rankRelations.id] })
}))

export const signupSlotRanksRelations = relations(signupSlotRanks, ({ one }) => ({
    slot: one(signupSlots, { fields: [signupSlotRanks.slotId], references: [signupSlots.id] }),
    rank: one(rankRelations, { fields: [signupSlotRanks.rankId], references: [rankRelations.id] })
}))

export const shiftSignupsRelations = relations(shiftSignups, ({ one }) => ({
    slot: one(signupSlots, { fields: [shiftSignups.slotId], references: [signupSlots.id] }),
    event: one(events, { fields: [shiftSignups.eventId], references: [events.eventId] }),
    user: one(users, { fields: [shiftSignups.userId], references: [users.id] })
}))

export type SignupSheet = typeof signupSheets.$inferSelect
export type SignupSlot = typeof signupSlots.$inferSelect
export type ShiftSignup = typeof shiftSignups.$inferSelect
