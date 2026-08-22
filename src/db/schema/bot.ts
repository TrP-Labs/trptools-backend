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
    /** Pinged when a shift starts, and when it is announced if `pingUpcoming`. */
    shiftPingRole: text('shift_ping_role'),
    /**
     * Whether the "a shift is coming up" post pings that role too.
     *
     * Off by default: the upcoming notice usually goes out a day ahead, where
     * a ping is noise rather than news, and a group that pings on both ends up
     * training people to mute the role that matters when the shift starts.
     */
    pingUpcoming: boolean('ping_upcoming').notNull().default(false),
    /** Pinged by the host reminder. */
    hostPingRole: text('host_ping_role'),

    // --- Roblox join link ---------------------------------------------------
    /**
     * The place shifts are run in. Fixed — there is one, it does not change,
     * and it was a text box on the bot page for no reason other than that the
     * legacy TOML had one. Nothing writes this any more.
     */
    placeId: text('place_id').notNull().default('2337102976'),
    /**
     * Whose private server the join link points at.
     *
     * A cache of the Roblox group's owner, not a setting: `src/bot/owner.ts`
     * resolves it and writes it back, and it is read only when Roblox cannot
     * be reached. A host who needs a different server for one shift overrides
     * it on that occurrence with `/edit-shift`.
     */
    ownerRobloxId: text('owner_roblox_id'),

    /**
     * Whether the public start announcement prints the join code as text.
     *
     * The join button carries the code either way, so turning this off does
     * not lock anybody out — it stops the code existing as copyable text in a
     * channel it outlives the shift in. Staff messages always show it: the
     * whole point of `/staff-begin` is handing it to the people on shift.
     */
    announceJoinCode: boolean('announce_join_code').notNull().default(true),

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

    /**
     * Letting the people who signed up in early.
     *
     * Deliberately its own trigger rather than part of the start announcement:
     * staff are expected on shift before the public arrives, so this normally
     * runs a good while ahead of it.
     */
    autoStaffStart: boolean('auto_staff_start').notNull().default(false),
    autoStaffStartLead: integer('auto_staff_start_lead').notNull().default(15),

    /** The "starting now" announcement. */
    autoBegin: boolean('auto_begin').notNull().default(false),
    autoBeginLead: integer('auto_begin_lead').notNull().default(0),

    /** Cleanup and the satisfaction poll, this many minutes after the end. */
    autoComplete: boolean('auto_complete').notNull().default(false),
    autoCompleteDelay: integer('auto_complete_delay').notNull().default(5),

    /** How often the live manifest image under a start announcement redraws. */
    manifestRefreshSeconds: integer('manifest_refresh_seconds').notNull().default(120),

    // --- End-of-shift cleanup ------------------------------------------------
    // Closing a shift out deletes the messages the bot posted for it, and
    // nothing else — it has never bulk-deleted a channel. These say which of
    // its own posts a group actually wants taken down, grouped by the channel
    // they live in, because that is how a group thinks about it. All three
    // default on, which is what cleanup did before they existed.
    /** The sheets themselves and the "come on in" pings, in each rank's channel. */
    clearSignups: boolean('clear_signups').notNull().default(true),
    /** The upcoming notice, the start announcement and the board under it. */
    clearAnnouncements: boolean('clear_announcements').notNull().default(true),
    /** The "a shift needs a host" reminder. */
    clearHostReminders: boolean('clear_host_reminders').notNull().default(true)
})

export const botConfigsRelations = relations(botConfigs, ({ one }) => ({
    group: one(groups, { fields: [botConfigs.groupId], references: [groups.id] }),
    installer: one(users, { fields: [botConfigs.installedBy], references: [users.id] })
}))

export type BotConfig = typeof botConfigs.$inferSelect
