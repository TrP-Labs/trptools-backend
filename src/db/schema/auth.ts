import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const sessions = pgTable(
    'sessions',
    {
        // sha256 of the token the browser holds; the plaintext never lands here.
        sessionId: text('session_id').primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),

        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

        userAgent: text('user_agent'),
        ip: text('ip')
    },
    (table) => [index('sessions_user_idx').on(table.userId), index('sessions_expiry_idx').on(table.expiresAt)]
)

export const sessionsRelations = relations(sessions, ({ one }) => ({
    user: one(users, { fields: [sessions.userId], references: [users.id] })
}))

export const apiKeys = pgTable(
    'api_keys',
    {
        keyId: uuid('key_id').primaryKey().defaultRandom(),
        token: text('token').notNull().unique(),
        name: text('name').notNull().default('API key'),
        prefix: text('prefix').notNull(),

        // Space separated, e.g. "groups:read dispatch:write"
        scopes: text('scopes').notNull().default('groups:read routes:read schedule:read'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),

        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' })
    },
    (table) => [index('api_keys_user_idx').on(table.userId)]
)

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
    user: one(users, { fields: [apiKeys.userId], references: [users.id] })
}))

export type Session = typeof sessions.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
