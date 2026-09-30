import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { groups } from './groups'
import { users } from './users'

export const groupFollows = pgTable('group_follows', {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [primaryKey({ columns: [table.userId, table.groupId] }), index('group_follows_group_idx').on(table.groupId)])
