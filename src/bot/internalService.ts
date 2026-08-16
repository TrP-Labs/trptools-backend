import { status } from 'elysia'
import { and, eq } from 'drizzle-orm'
import db from '../db'
import { botConfigs, events, groups, shiftSignups, users } from '../db/schema'
import { FRONTEND_URL } from '../utils/env'
import { dataRedis } from '../utils/redis'
import { activeOccurrence, occurrencesBetween, upcomingOccurrences } from '../utils/recurrence'
import { publishSignupChange } from '../schedule/events'
import { loadSheets, loadSignups, type LoadedSheet } from '../schedule/sheets'
import { BotInternal } from './internalModel'
import type { BotModel } from './model'
import { presentConfig } from './present'

/**
 * A host's note and server override for one occurrence.
 *
 * Kept in Redis rather than a table: it is per-occurrence, short-lived and
 * meaningless once the shift has run. The legacy bot did the same, and giving
 * every occurrence of every recurring shift a row would be a lot of storage
 * for something with a 30-day useful life.
 */
const noteKey = (eventId: string, occurrence: Date) => `shiftnote:${eventId}:${occurrence.getTime()}`
const NOTE_TTL = 60 * 60 * 24 * 30

type StoredNote = { note: string; ownerRobloxId: string | null }

async function readNote(eventId: string, occurrence: Date): Promise<StoredNote> {
    const raw = await dataRedis.get(noteKey(eventId, occurrence)).catch(() => null)
    if (!raw) return { note: '', ownerRobloxId: null }

    try {
        return JSON.parse(raw) as StoredNote
    } catch {
        return { note: '', ownerRobloxId: null }
    }
}

type TrimmedSignup = { userId: string; displayName: string | null; discordId: string | null }

function presentSheet(
    sheet: LoadedSheet,
    signups: Map<string, TrimmedSignup[]>,
    eventId: string,
    occurrence: Date
): BotInternal.sheet {
    return {
        signupId: sheet.signupId,
        rankId: sheet.rankId,
        rankName: sheet.rankName,
        robloxRank: sheet.robloxRank,
        name: sheet.name,
        description: sheet.description,
        color: sheet.color,
        discordChannel: sheet.discordChannel,
        discordPingRole: sheet.discordPingRole,
        slots: sheet.slots.map((slot) => ({
            ...slot,
            signups: signups.get(`${eventId}:${occurrence.getTime()}:${slot.id}`) ?? []
        }))
    }
}

/** Sheets for one occurrence, trimmed to what the bot renders. */
async function sheetsFor(groupId: string, eventId: string, occurrence: Date): Promise<BotInternal.sheet[]> {
    const sheets = await loadSheets(groupId)
    if (sheets.length === 0) return []

    const raw = await loadSignups(
        sheets.flatMap((sheet) => sheet.slots.map((slot) => slot.id)),
        [eventId],
        occurrence,
        occurrence
    )

    const trimmed = new Map<string, TrimmedSignup[]>()
    for (const [key, people] of raw) {
        trimmed.set(
            key,
            people.map((person) => ({
                userId: person.userId,
                displayName: person.displayName ?? person.username,
                discordId: person.discordId
            }))
        )
    }

    return sheets.map((sheet) => presentSheet(sheet, trimmed, eventId, occurrence))
}

async function presentShift(
    event: typeof events.$inferSelect,
    occurrence: { start: Date; end: Date }
): Promise<BotInternal.shift> {
    const note = await readNote(event.eventId, occurrence.start)

    return {
        eventId: event.eventId,
        name: event.name,
        slug: event.slug,
        description: event.description,
        color: event.color,
        start: occurrence.start,
        end: occurrence.end,
        note: note.note,
        ownerRobloxId: note.ownerRobloxId
    }
}

async function requireGuild(guildId: string) {
    const [row] = await db
        .select({ config: botConfigs, group: groups })
        .from(botConfigs)
        .innerJoin(groups, eq(botConfigs.groupId, groups.id))
        .where(eq(botConfigs.guildId, guildId))
        .limit(1)

    if (!row) throw status(404, 'Not Found')
    return row
}

export abstract class BotService {
    /** Every connected guild, which is what the bot loads on startup. */
    static async guilds(): Promise<BotInternal.guilds> {
        const rows = await db
            .select({ config: botConfigs, group: groups })
            .from(botConfigs)
            .innerJoin(groups, eq(botConfigs.groupId, groups.id))

        return Promise.all(rows.map((row) => BotService.describe(row.config, row.group)))
    }

    static async guild(guildId: string): Promise<BotInternal.guild> {
        const { config, group } = await requireGuild(guildId)
        return BotService.describe(config, group)
    }

    private static async describe(
        config: typeof botConfigs.$inferSelect,
        group: typeof groups.$inferSelect
    ): Promise<BotInternal.guild> {
        const sheets = await loadSheets(group.id)

        return {
            guildId: config.guildId,
            groupId: group.id,
            groupSlug: group.slug,
            groupName: group.cachedName ?? group.slug,
            siteUrl: FRONTEND_URL,
            config: presentConfig(config) satisfies BotModel.config,
            sheets: sheets.map((sheet) => ({
                signupId: sheet.signupId,
                rankId: sheet.rankId,
                rankName: sheet.rankName,
                robloxRank: sheet.robloxRank,
                name: sheet.name,
                description: sheet.description,
                color: sheet.color,
                discordChannel: sheet.discordChannel,
                discordPingRole: sheet.discordPingRole,
                slots: sheet.slots.map((slot) => ({ ...slot, signups: [] }))
            }))
        }
    }

    /**
     * The shift a command is about.
     *
     * `current` is what "the shift is starting" refers to and matches the
     * dispatch room's own idea of live, so a host running /begin and a host
     * opening a room are always talking about the same occurrence. `next` is
     * the soonest one that has not started.
     */
    static async shift(guildId: string, when: 'next' | 'current' = 'next'): Promise<BotInternal.shiftOrNull> {
        const { group } = await requireGuild(guildId)

        const rows = await db.select().from(events).where(eq(events.groupId, group.id))
        if (rows.length === 0) return null

        const lead = group.roomOpenLeadMinutes ?? 10

        if (when === 'current') {
            let best: { event: typeof events.$inferSelect; occurrence: { start: Date; end: Date } } | null = null

            for (const event of rows) {
                const live = activeOccurrence(event.rrule, event.startTime, event.duration, lead)
                if (live && (!best || live.start < best.occurrence.start)) {
                    best = { event, occurrence: live }
                }
            }

            return best ? presentShift(best.event, best.occurrence) : null
        }

        const now = new Date()
        let soonest: { event: typeof events.$inferSelect; occurrence: { start: Date; end: Date } } | null = null

        for (const event of rows) {
            const [next] = upcomingOccurrences(event.rrule, event.startTime, event.duration, now, 1)
            if (next && (!soonest || next.start < soonest.occurrence.start)) {
                soonest = { event, occurrence: next }
            }
        }

        return soonest ? presentShift(soonest.event, soonest.occurrence) : null
    }

    static async occurrence(guildId: string, query: BotInternal.occurrenceQuery): Promise<BotInternal.occurrence> {
        const { group } = await requireGuild(guildId)

        const occurrence = new Date(query.occurrence)
        if (Number.isNaN(occurrence.getTime())) throw status(400, 'Bad Request')

        const [event] = await db
            .select()
            .from(events)
            .where(and(eq(events.eventId, query.eventId), eq(events.groupId, group.id)))
            .limit(1)

        if (!event) throw status(404, 'Not Found')

        const end = new Date(occurrence.getTime() + event.duration * 60_000)

        return {
            shift: await presentShift(event, { start: occurrence, end }),
            sheets: await sheetsFor(group.id, event.eventId, occurrence)
        }
    }

    /**
     * Takes, moves or releases a slot on behalf of a Discord user.
     *
     * Selecting a slot you already hold releases it, and selecting a different
     * one on the same sheet moves you — the legacy bot made people withdraw
     * first, which was a needless round trip through an ephemeral reply.
     *
     * A Discord account linked to a TrPTools user is recorded as that user, so
     * the website and the sheet show one person rather than two.
     */
    static async signup(guildId: string, body: BotInternal.signupBody): Promise<BotInternal.signupResult> {
        const { group } = await requireGuild(guildId)

        const occurrence = new Date(body.occurrence)
        if (Number.isNaN(occurrence.getTime())) throw status(400, 'Bad Request')

        const [event] = await db
            .select()
            .from(events)
            .where(and(eq(events.eventId, body.eventId), eq(events.groupId, group.id)))
            .limit(1)

        if (!event) throw status(404, 'Not Found')

        // The occurrence has to be one the shift really runs, or the row would
        // never surface again.
        const matches = occurrencesBetween(
            event.rrule,
            event.startTime,
            event.duration,
            new Date(occurrence.getTime() - 1000),
            new Date(occurrence.getTime() + 1000),
            1
        )
        if (matches.length === 0) throw status(400, 'Bad Request')

        const sheets = await loadSheets(group.id)
        const sheet = sheets.find((candidate) => candidate.slots.some((slot) => slot.id === body.slotId))
        const slot = sheet?.slots.find((candidate) => candidate.id === body.slotId)

        if (!sheet || !slot) return { status: 'GONE', slotName: '', previousSlotName: null }

        const [linked] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.discordId, body.discordUserId))
            .limit(1)

        const identity = linked
            ? { userId: linked.id, discordUserId: null, discordUsername: null }
            : { userId: null, discordUserId: body.discordUserId, discordUsername: body.discordUsername }

        const slotIds = sheet.slots.map((candidate) => candidate.id)

        const existing = await db
            .select({
                id: shiftSignups.id,
                slotId: shiftSignups.slotId,
                userId: shiftSignups.userId,
                discordUserId: shiftSignups.discordUserId
            })
            .from(shiftSignups)
            .where(and(eq(shiftSignups.eventId, body.eventId), eq(shiftSignups.occurrence, occurrence)))

        const isThem = (row: (typeof existing)[number]) =>
            linked ? row.userId === linked.id : row.discordUserId === body.discordUserId

        const held = existing.find((row) => isThem(row) && slotIds.includes(row.slotId))

        // Selecting the slot they already hold gives it up.
        if (held?.slotId === body.slotId) {
            await db.delete(shiftSignups).where(eq(shiftSignups.id, held.id))
            await publishSignupChange(group.id, body.eventId, occurrence, sheet.signupId)

            return { status: 'RELEASED', slotName: slot.name, previousSlotName: null }
        }

        const takenHere = existing.filter((row) => row.slotId === body.slotId)
        if (takenHere.length >= slot.capacity) {
            return { status: 'FULL', slotName: slot.name, previousSlotName: null }
        }

        const previous = held ? (sheet.slots.find((candidate) => candidate.id === held.slotId)?.name ?? null) : null
        if (held) await db.delete(shiftSignups).where(eq(shiftSignups.id, held.id))

        await db.insert(shiftSignups).values({
            slotId: body.slotId,
            eventId: body.eventId,
            occurrence,
            ...identity
        })

        await publishSignupChange(group.id, body.eventId, occurrence, sheet.signupId)

        return {
            status: held ? 'MOVED' : 'TAKEN',
            slotName: slot.name,
            previousSlotName: previous
        }
    }

    static async setNote(guildId: string, body: BotInternal.noteBody) {
        await requireGuild(guildId)

        const occurrence = new Date(body.occurrence)
        if (Number.isNaN(occurrence.getTime())) throw status(400, 'Bad Request')

        const value: StoredNote = { note: body.note, ownerRobloxId: body.ownerRobloxId }
        await dataRedis.set(noteKey(body.eventId, occurrence), JSON.stringify(value), 'EX', NOTE_TTL)

        return 'Success' as const
    }
}

/** Frees the per-occurrence extras once a shift is closed out. */
export async function clearOccurrenceState(eventId: string, occurrence: Date) {
    await dataRedis.del(noteKey(eventId, occurrence)).catch(() => undefined)
}
