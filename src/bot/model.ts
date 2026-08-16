import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'

export namespace BotModel {
    /** Snowflakes are 64-bit; they travel as digit strings, never numbers. */
    export const snowflake = t.String({ pattern: '^[0-9]{15,25}$' })
    export const nullableSnowflake = t.Union([snowflake, t.Null()])

    // ------------------------------------------------------------- install

    export const installQuery = t.Object({
        groupId: t.String()
    })
    export type installQuery = typeof installQuery.static

    export const installResponse = t.Object({
        /** Where to send the browser to add the bot to a server. */
        url: t.String()
    })
    export type installResponse = typeof installResponse.static

    export const callbackQuery = t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        guild_id: t.Optional(t.String()),
        error: t.Optional(t.String())
    })
    export type callbackQuery = typeof callbackQuery.static

    // -------------------------------------------------------------- status

    export const permissionStatus = t.Object({
        name: t.String(),
        /** Human wording for the dashboard, e.g. "Send messages". */
        label: t.String(),
        granted: t.Boolean()
    })

    export const guildStatus = t.Object({
        guildId: t.String(),
        name: t.Union([t.String(), t.Null()]),
        icon: t.Union([t.String(), t.Null()]),
        /**
         * False when Discord no longer reports the bot as a member — it was
         * kicked, or the guild was deleted. The dashboard offers a reinstall
         * rather than pretending the configuration still applies.
         */
        present: t.Boolean(),
        permissions: t.Array(permissionStatus),
        /** True when every required permission is granted guild-wide. */
        healthy: t.Boolean()
    })
    export type guildStatus = typeof guildStatus.static

    // ------------------------------------------------------------- config

    export const config = t.Object({
        groupId: t.String(),
        guildId: t.String(),
        installedAt: t.Date(),

        announcementChannel: t.Union([t.String(), t.Null()]),
        pollChannel: t.Union([t.String(), t.Null()]),
        hostChannel: t.Union([t.String(), t.Null()]),

        shiftPingRole: t.Union([t.String(), t.Null()]),
        hostPingRole: t.Union([t.String(), t.Null()]),

        placeId: t.String(),
        ownerRobloxId: t.Union([t.String(), t.Null()]),

        announcementsEnabled: t.Boolean(),
        signupsEnabled: t.Boolean(),
        pollsEnabled: t.Boolean(),
        remindersEnabled: t.Boolean(),
        manifestEnabled: t.Boolean(),

        autoAnnounce: t.Boolean(),
        autoAnnounceLead: t.Number(),
        autoSignups: t.Boolean(),
        autoSignupsLead: t.Number(),
        autoHostReminder: t.Boolean(),
        autoHostReminderLead: t.Number(),
        autoStaffStart: t.Boolean(),
        autoStaffStartLead: t.Number(),
        autoBegin: t.Boolean(),
        autoBeginLead: t.Number(),
        autoComplete: t.Boolean(),
        autoCompleteDelay: t.Number(),

        manifestRefreshSeconds: t.Number()
    })
    export type config = typeof config.static

    /** The whole bot page in one read: config plus live guild health. */
    export const overview = t.Object({
        connected: t.Boolean(),
        /** False when the instance has no Discord credentials configured. */
        available: t.Boolean(),
        config: t.Union([config, t.Null()]),
        guild: t.Union([guildStatus, t.Null()])
    })
    export type overview = typeof overview.static

    const leadMinutes = t.Integer({ minimum: 0, maximum: 20160 })

    export const updateBody = t.Object({
        announcementChannel: t.Optional(nullableSnowflake),
        pollChannel: t.Optional(nullableSnowflake),
        hostChannel: t.Optional(nullableSnowflake),

        shiftPingRole: t.Optional(nullableSnowflake),
        hostPingRole: t.Optional(nullableSnowflake),

        placeId: t.Optional(t.String({ pattern: '^[0-9]{1,20}$' })),
        ownerRobloxId: t.Optional(t.Union([t.String({ pattern: '^[0-9]{1,20}$' }), t.Null()])),

        announcementsEnabled: t.Optional(t.Boolean()),
        signupsEnabled: t.Optional(t.Boolean()),
        pollsEnabled: t.Optional(t.Boolean()),
        remindersEnabled: t.Optional(t.Boolean()),
        manifestEnabled: t.Optional(t.Boolean()),

        autoAnnounce: t.Optional(t.Boolean()),
        autoAnnounceLead: t.Optional(leadMinutes),
        autoSignups: t.Optional(t.Boolean()),
        autoSignupsLead: t.Optional(leadMinutes),
        autoHostReminder: t.Optional(t.Boolean()),
        autoHostReminderLead: t.Optional(leadMinutes),
        autoStaffStart: t.Optional(t.Boolean()),
        autoStaffStartLead: t.Optional(leadMinutes),
        autoBegin: t.Optional(t.Boolean()),
        autoBeginLead: t.Optional(leadMinutes),
        autoComplete: t.Optional(t.Boolean()),
        autoCompleteDelay: t.Optional(leadMinutes),

        manifestRefreshSeconds: t.Optional(t.Integer({ minimum: 30, maximum: 3600 }))
    })
    export type updateBody = typeof updateBody.static

    // ------------------------------------------------- channels and roles

    export const channel = t.Object({
        id: t.String(),
        name: t.String(),
        type: t.Number(),
        /** The category it sits under, for grouping in the picker. */
        parentId: t.Union([t.String(), t.Null()]),
        parentName: t.Union([t.String(), t.Null()]),
        position: t.Number(),
        /** Whether the bot can see the channel at all. */
        canRead: t.Boolean(),
        /** Whether the bot can post an embed with an image in it. */
        canSend: t.Boolean()
    })
    export type channel = typeof channel.static

    export const channelList = t.Array(channel)
    export type channelList = typeof channelList.static

    export const role = t.Object({
        id: t.String(),
        name: t.String(),
        /** Hex, already resolved from Discord's integer colour. */
        color: t.String(),
        position: t.Number(),
        /**
         * False for roles the bot cannot ping. A managed role belongs to an
         * integration and a role above the bot's own highest role cannot be
         * mentioned by it unless it also holds Mention Everyone.
         */
        canMention: t.Boolean(),
        managed: t.Boolean(),
        memberCount: t.Union([t.Number(), t.Null()])
    })
    export type role = typeof role.static

    export const roleList = t.Array(role)
    export type roleList = typeof roleList.static

    export const refreshQuery = t.Object({
        /** Drops the cached guild reads before answering. */
        refresh: t.Optional(t.String())
    })
    export type refreshQuery = typeof refreshQuery.static

    // -------------------------------------------------------------- errors

    export const notConnected = t.Literal('no bot is connected to this group')
    export type notConnected = typeof notConnected.static

    export const unavailable = t.Literal('Discord is not configured on this instance')
    export type unavailable = typeof unavailable.static

    export const guildTaken = t.Literal('that Discord server is already connected to another group')
    export type guildTaken = typeof guildTaken.static

    export const errors = {
        401: globalModel.unauthorized,
        403: globalModel.forbidden,
        404: notConnected
    }
}
