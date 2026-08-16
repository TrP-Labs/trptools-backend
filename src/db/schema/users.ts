import { relations } from 'drizzle-orm'
import { bigint, boolean, index, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sessions, apiKeys } from './auth'
import { routePreferences } from './routes'
import { shiftSignups } from './signups'
import { stagePrograms } from './tools'

export const users = pgTable(
    'users',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        robloxId: bigint('roblox_id', { mode: 'number' }).notNull().unique(),
        siteRank: text('site_rank').notNull().default('user'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

        // Cached Roblox identity so rendering a profile never blocks on Roblox.
        cachedUsername: text('cached_username'),
        cachedDisplayName: text('cached_display_name'),
        cachedAvatar: text('cached_avatar'),
        cachedAt: timestamp('cached_at', { withTimezone: true }),

        /**
         * The user's Roblox OAuth tokens, encrypted at rest. Open Cloud v2
         * requires a bearer token for group reads, and refresh tokens stay
         * valid for 90 days, so we hold on to them and rotate as needed.
         */
        robloxAccessToken: text('roblox_access_token'),
        robloxRefreshToken: text('roblox_refresh_token'),
        robloxTokenExpiresAt: timestamp('roblox_token_expires_at', { withTimezone: true }),
        robloxScopes: text('roblox_scopes').notNull().default(''),

        /**
         * A linked Discord account, so a sign-up taken from a Discord sheet
         * shows the same person as one taken on the web. Optional — the site
         * works without it, and a Discord sign-up from an unlinked account is
         * still recorded against its Discord id.
         */
        discordId: text('discord_id').unique(),
        discordUsername: text('discord_username'),

        /**
         * Account suspension, applied by a site admin.
         *
         * `bannedAt` set means access is withheld. `banExpiresAt` is what
         * separates the two cases the UI offers: a date makes it a suspension
         * that lapses on its own, null makes it a permanent ban. The row is
         * kept after a suspension lapses so an admin can still see the history
         * — whether a ban is *in force* is a question about the clock, not a
         * stored flag (`isBanned` in utils/moderation).
         */
        bannedAt: timestamp('banned_at', { withTimezone: true }),
        banExpiresAt: timestamp('ban_expires_at', { withTimezone: true }),
        banReason: text('ban_reason').notNull().default(''),
        bannedBy: uuid('banned_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),

        // Preferences
        theme: text('theme').notNull().default('dim'),
        locale: text('locale').notNull().default('en'),
        timezone: text('timezone').notNull().default('UTC'),
        profilePublic: boolean('profile_public').notNull().default(true)
    },
    (table) => [
        index('users_cached_username_idx').on(table.cachedUsername),
        index('users_banned_idx').on(table.bannedAt)
    ]
)

export const usersRelations = relations(users, ({ many }) => ({
    sessions: many(sessions),
    apiKeys: many(apiKeys),
    routePreferences: many(routePreferences),
    signups: many(shiftSignups),
    stagePrograms: many(stagePrograms)
}))

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
