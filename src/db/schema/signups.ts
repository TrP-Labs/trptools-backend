import { relations, sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { rankRelations } from './groups'
import { events } from './events'
import { users } from './users'
import { translations } from './translations'

/**
 * A sign-up sheet attached to a Roblox rank.
 *
 * Sign-ups are a staff feature, not a public one, so they hang off the rank
 * that is allowed to fill them rather than off an individual shift. One sheet
 * per rank applies to every shift the group runs, which is how the Discord bot
 * has always worked and saves re-declaring the same roles on each shift.
 *
 * Visibility follows from the rank: someone sees a sheet when their own Roblox
 * rank is at least the bound rank's, so a driver never sees the dispatcher
 * sheet while a manager sees both.
 *
 * The Discord columns are optional. A group with no bot still gets working
 * sign-ups on the web.
 */
export const rankSignups = pgTable('rank_signups', {
    id: uuid('id').primaryKey().defaultRandom(),
    rankId: uuid('rank_id')
        .notNull()
        .unique()
        .references(() => rankRelations.id, { onDelete: 'cascade' }),

    enabled: boolean('enabled').notNull().default(false),
    name: text('name').notNull().default('Staff'),
    description: text('description').notNull().default(''),
    /** Per-language versions of the text above. See `./translations.ts`. */
    translations: translations(),
    color: text('color').notNull().default('#4287f5'),

    /** Where the bot posts this sheet. Falls back to nothing, not to a default. */
    discordChannel: text('discord_channel'),
    /** Pinged when the sheet is posted. */
    discordPingRole: text('discord_ping_role')
})

export const rankSignupSlots = pgTable(
    'rank_signup_slots',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        signupId: uuid('signup_id')
            .notNull()
            .references(() => rankSignups.id, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        capacity: integer('capacity').notNull().default(1),
        order: integer('order').notNull().default(0)
    },
    (table) => [index('rank_signup_slots_order_idx').on(table.signupId, table.order)]
)

/**
 * One person taking one slot on one concrete occurrence of one shift.
 *
 * `eventId` is carried alongside the occurrence timestamp because slots are
 * shared across every shift now — without it, two shifts starting at the same
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
            .references(() => rankSignupSlots.id, { onDelete: 'cascade' }),
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

export const rankSignupsRelations = relations(rankSignups, ({ one, many }) => ({
    rank: one(rankRelations, { fields: [rankSignups.rankId], references: [rankRelations.id] }),
    slots: many(rankSignupSlots)
}))

export const rankSignupSlotsRelations = relations(rankSignupSlots, ({ one, many }) => ({
    signup: one(rankSignups, { fields: [rankSignupSlots.signupId], references: [rankSignups.id] }),
    signups: many(shiftSignups)
}))

export const shiftSignupsRelations = relations(shiftSignups, ({ one }) => ({
    slot: one(rankSignupSlots, { fields: [shiftSignups.slotId], references: [rankSignupSlots.id] }),
    event: one(events, { fields: [shiftSignups.eventId], references: [events.eventId] }),
    user: one(users, { fields: [shiftSignups.userId], references: [users.id] })
}))

export type RankSignup = typeof rankSignups.$inferSelect
export type RankSignupSlot = typeof rankSignupSlots.$inferSelect
export type ShiftSignup = typeof shiftSignups.$inferSelect
