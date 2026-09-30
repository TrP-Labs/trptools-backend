import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, date, timestamp, integer, index, primaryKey } from 'drizzle-orm/pg-core'
import { groups } from './groups'
/** Anonymous counters: no account, address, browser fingerprint or referrer. */
export const statisticsEvents = pgTable('statistics_events', {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true })
}, t => [index('statistics_events_pending_idx').on(t.receivedAt).where(sql`${t.processedAt} IS NULL`), index('statistics_events_retention_idx').on(t.receivedAt), index('statistics_events_group_idx').on(t.groupId, t.processedAt)])
export const statisticsDaily = pgTable('statistics_daily', {
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    kind: text('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    count: integer('count').notNull().default(0)
}, t => [primaryKey({ columns: [t.groupId, t.day, t.kind, t.targetId] })])
