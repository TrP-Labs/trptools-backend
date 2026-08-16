import { relations } from 'drizzle-orm'
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { groups } from './groups'
import { users } from './users'

/**
 * One Discord guild bound to one TrPTools group.
 *
 * The bot used to read a per-server TOML file. Everything it needs now lives
 * here instead, written from the dashboard, so a group configures itself
 * without anyone touching the bot's filesystem.
 *
 * Channel and role columns hold Discord snowflakes as text. They are 64-bit
 * and JSON cannot carry that precision, so they are strings the whole way
 * through — never numbers.
 */
export const botConfigs = pgTable('bot_configs', {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
        .notNull()
        .unique()
        .references(() => groups.id, { onDelete: 'cascade' }),

    guildId: text('guild_id').notNull().unique(),

    /** Shown on the dashboard so the guild is recognisable without a fetch. */
    cachedGuildName: text('cached_guild_name'),
    cachedGuildIcon: text('cached_guild_icon'),
    cachedAt: timestamp('cached_at', { withTimezone: true }),

    installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),

    // --- Channels -----------------------------------------------------------
    /** Where shift announcements are posted. */
    announcementChannel: text('announcement_channel'),
    /** Where the post-shift satisfaction poll is posted. */
    pollChannel: text('poll_channel'),
    /** Where hosts are reminded that a shift is theirs to open. */
    hostChannel: text('host_channel'),

    // --- Roles --------------------------------------------------------------
    /** Pinged when a shift is announced or starts. */
    shiftPingRole: text('shift_ping_role'),
    /** Pinged by the host reminder. */
    hostPingRole: text('host_ping_role'),

    // --- Roblox join link ---------------------------------------------------
    placeId: text('place_id').notNull().default('2337102976'),
    /**
     * Whose private server the join link points at. A shift can override this
     * for one occurrence; this is the fallback.
     */
    ownerRobloxId: text('owner_roblox_id'),

    // --- Features -----------------------------------------------------------
    // Each of these gates a whole capability, automated or not. Turning one
    // off also hides its slash command's effect rather than only its schedule.
    announcementsEnabled: boolean('announcements_enabled').notNull().default(true),
    signupsEnabled: boolean('signups_enabled').notNull().default(true),
    pollsEnabled: boolean('polls_enabled').notNull().default(true),
    remindersEnabled: boolean('reminders_enabled').notNull().default(true),
    manifestEnabled: boolean('manifest_enabled').notNull().default(true),

    // --- Automation ---------------------------------------------------------
    // The slash commands stay usable regardless. These decide whether the bot
    // also fires each action on its own, and how far ahead of the shift.
    autoAnnounce: boolean('auto_announce').notNull().default(false),
    /** Minutes before the shift starts. */
    autoAnnounceLead: integer('auto_announce_lead').notNull().default(1440),

    autoSignups: boolean('auto_signups').notNull().default(false),
    autoSignupsLead: integer('auto_signups_lead').notNull().default(180),

    autoHostReminder: boolean('auto_host_reminder').notNull().default(false),
    autoHostReminderLead: integer('auto_host_reminder_lead').notNull().default(30),

    /** The "starting now" announcement. */
    autoBegin: boolean('auto_begin').notNull().default(false),
    autoBeginLead: integer('auto_begin_lead').notNull().default(0),

    /** Cleanup and the satisfaction poll, this many minutes after the end. */
    autoComplete: boolean('auto_complete').notNull().default(false),
    autoCompleteDelay: integer('auto_complete_delay').notNull().default(5),

    /** How often the live manifest image under a start announcement redraws. */
    manifestRefreshSeconds: integer('manifest_refresh_seconds').notNull().default(120)
})

export const botConfigsRelations = relations(botConfigs, ({ one }) => ({
    group: one(groups, { fields: [botConfigs.groupId], references: [groups.id] }),
    installer: one(users, { fields: [botConfigs.installedBy], references: [users.id] })
}))

export type BotConfig = typeof botConfigs.$inferSelect
