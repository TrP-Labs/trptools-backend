import { relations } from 'drizzle-orm'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { groups, rankRelations } from './groups'

/**
 * Configuration consumed by trptools-bot. A group is configured once on the
 * web and the bot reads it back over the API, replacing the per-server TOML
 * files it ships with today.
 */
export const botConfigs = pgTable('bot_configs', {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
        .notNull()
        .unique()
        .references(() => groups.id, { onDelete: 'cascade' }),

    guildId: text('guild_id').notNull().unique(),

    announcementChannel: text('announcement_channel'),
    pollChannel: text('poll_channel'),
    shiftPingRole: text('shift_ping_role'),
    ownerRobloxId: text('owner_roblox_id'),
    placeId: text('place_id').notNull().default('2337102976')
})

export const staffRequests = pgTable('staff_requests', {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id')
        .notNull()
        .references(() => botConfigs.id, { onDelete: 'cascade' }),

    name: text('name').notNull().default('Staff'),
    announcementChannel: text('announcement_channel').notNull(),
    color: text('color').notNull().default('#4287f5'),
    slots: text('slots').array().notNull().default([]),

    bindedRankId: uuid('binded_rank_id')
        .notNull()
        .unique()
        .references(() => rankRelations.id, { onDelete: 'cascade' })
})

export const botConfigsRelations = relations(botConfigs, ({ one, many }) => ({
    group: one(groups, { fields: [botConfigs.groupId], references: [groups.id] }),
    staffRequests: many(staffRequests)
}))

export const staffRequestsRelations = relations(staffRequests, ({ one }) => ({
    parent: one(botConfigs, { fields: [staffRequests.parentId], references: [botConfigs.id] }),
    bindedRank: one(rankRelations, { fields: [staffRequests.bindedRankId], references: [rankRelations.id] })
}))

export type BotConfig = typeof botConfigs.$inferSelect
export type StaffRequest = typeof staffRequests.$inferSelect
