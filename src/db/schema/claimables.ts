import { boolean, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { groups, rankRelations } from './groups'
import { users } from './users'
import { translations } from './translations'

export const claimableConnections = pgTable('claimable_connections', {
    groupId: uuid('group_id').primaryKey().references(() => groups.id, { onDelete: 'cascade' }),
    authorizedBy: uuid('authorized_by').notNull().references(() => users.id, { onDelete: 'cascade' })
})

export const claimableRanks = pgTable('claimable_ranks', {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    rankId: uuid('rank_id').references(() => rankRelations.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    translations: translations(),
    color: text('color').notNull().default('#4287f5'),
    enabled: boolean('enabled').notNull().default(false),
    minimumAccountAgeDays: integer('minimum_account_age_days').notNull().default(0),
    requireDiscord: boolean('require_discord').notNull().default(false),
    maximumRank: integer('maximum_rank').notNull()
}, (table) => [unique('claimable_ranks_group_slug_unique').on(table.groupId, table.slug)])
