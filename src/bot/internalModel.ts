import { t } from 'elysia'
import { BotModel } from './model'

/**
 * The surface the trptools-bot process talks to.
 *
 * It is deliberately separate from the dashboard's own routes. The bot acts
 * across every group at once and identifies itself with a service token, so
 * none of the per-user permission reasoning applies to it — keeping the two
 * apart means neither can be reached with the wrong sort of credential by
 * accident.
 */
export namespace BotInternal {
    export const slot = t.Object({
        id: t.String(),
        name: t.String(),
        description: t.String(),
        capacity: t.Number(),
        order: t.Number(),
        signups: t.Array(
            t.Object({
                /** Empty for someone who signed up from Discord and has no account. */
                userId: t.String(),
                displayName: t.Union([t.String(), t.Null()]),
                discordId: t.Union([t.String(), t.Null()])
            })
        )
    })

    export const sheet = t.Object({
        signupId: t.String(),
        rankId: t.String(),
        rankName: t.String(),
        robloxRank: t.Number(),
        name: t.String(),
        description: t.String(),
        color: t.String(),
        discordChannel: t.Union([t.String(), t.Null()]),
        discordPingRole: t.Union([t.String(), t.Null()]),
        slots: t.Array(slot)
    })
    export type sheet = typeof sheet.static

    export const shift = t.Object({
        eventId: t.String(),
        name: t.String(),
        slug: t.String(),
        description: t.String(),
        color: t.String(),
        start: t.Date(),
        end: t.Date(),
        /** Free text a host set for this one occurrence. */
        note: t.String(),
        /** Whose private server to link to, overriding the group default. */
        ownerRobloxId: t.Union([t.String(), t.Null()])
    })
    export type shift = typeof shift.static

    /** Everything the bot needs to serve one guild. */
    export const guild = t.Object({
        guildId: t.String(),
        groupId: t.String(),
        groupSlug: t.String(),
        groupName: t.String(),
        /** Where to point "open on the website" links. */
        siteUrl: t.String(),
        config: BotModel.config,
        sheets: t.Array(sheet)
    })
    export type guild = typeof guild.static

    export const guilds = t.Array(guild)
    export type guilds = typeof guilds.static

    export const shiftQuery = t.Object({
        /**
         * `next` is the soonest upcoming occurrence; `current` is the one
         * running now, which is what a "starting" announcement refers to.
         */
        when: t.Optional(t.Union([t.Literal('next'), t.Literal('current')]))
    })
    export type shiftQuery = typeof shiftQuery.static

    export const shiftOrNull = t.Union([shift, t.Null()])
    export type shiftOrNull = typeof shiftOrNull.static

    export const occurrenceQuery = t.Object({
        eventId: t.String({ format: 'uuid' }),
        /** ISO 8601 with milliseconds, exactly as the schedule produced it. */
        occurrence: t.String()
    })
    export type occurrenceQuery = typeof occurrenceQuery.static

    export const occurrence = t.Object({
        shift: shift,
        sheets: t.Array(sheet)
    })
    export type occurrence = typeof occurrence.static

    export const signupBody = t.Object({
        slotId: t.String({ format: 'uuid' }),
        eventId: t.String({ format: 'uuid' }),
        occurrence: t.String(),
        discordUserId: t.String({ pattern: '^[0-9]{15,25}$' }),
        discordUsername: t.String({ maxLength: 80 })
    })
    export type signupBody = typeof signupBody.static

    /**
     * What happened, so the bot can word its ephemeral reply.
     *
     * `MOVED` covers picking a different slot on a sheet you already hold —
     * the legacy bot made people withdraw first, which was a needless step.
     */
    export const signupResult = t.Object({
        status: t.Union([
            t.Literal('TAKEN'),
            t.Literal('RELEASED'),
            t.Literal('MOVED'),
            t.Literal('FULL'),
            t.Literal('GONE')
        ]),
        slotName: t.String(),
        /** The slot they left, when this was a move. */
        previousSlotName: t.Union([t.String(), t.Null()])
    })
    export type signupResult = typeof signupResult.static

    export const noteBody = t.Object({
        eventId: t.String({ format: 'uuid' }),
        occurrence: t.String(),
        note: t.String({ maxLength: 1000 }),
        ownerRobloxId: t.Union([t.String({ pattern: '^[0-9]{1,20}$' }), t.Null()])
    })
    export type noteBody = typeof noteBody.static

    /** One automated action the bot should carry out now. */
    export const dueAction = t.Object({
        guildId: t.String(),
        groupId: t.String(),
        action: t.Union([
            t.Literal('ANNOUNCE'),
            t.Literal('SIGNUPS'),
            t.Literal('HOST_REMINDER'),
            t.Literal('BEGIN'),
            t.Literal('COMPLETE')
        ]),
        eventId: t.String(),
        occurrence: t.String()
    })
    export type dueAction = typeof dueAction.static

    export const dueActions = t.Array(dueAction)
    export type dueActions = typeof dueActions.static

    export const unauthorized = t.Literal('Unauthorized')
    export const notFound = t.Literal('Not Found')
}
