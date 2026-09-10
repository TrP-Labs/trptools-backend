import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import db from '../db'
import {
    rankRelations,
    shiftSignups,
    signupSheetRanks,
    signupSheets,
    signupSlotRanks,
    signupSlots,
    users
} from '../db/schema'
import type { Membership } from '../utils/groupPermission'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import type { ScheduleModel } from './model'
import type { Translations } from '../db/schema/translations'
import { presentTranslations } from '../utils/translations'
import { canFillSlot, canSeeSlot, type Viewer } from './eligibility'

/** One slot on a loaded sheet, with the ranks actually in force for it. */
export type LoadedSlot = {
    id: string
    name: string
    description: string
    translations: Translations
    capacity: number
    order: number
    /** `rank_relations` ids. Empty means every member of the group. */
    rankIds: string[]
    /** Their names, so a client can say who a slot is for without a lookup. */
    rankNames: string[]
}

/** A group's sign-up sheet with its slots, before any occurrence is applied. */
export type LoadedSheet = {
    sheetId: string
    name: string
    description: string
    translations: Translations
    color: string
    order: number
    uniformRanks: boolean
    discordChannel: string | null
    discordPingRole: string | null
    slots: LoadedSlot[]
}

/**
 * Every enabled sign-up sheet in a group, in the order the group put them in.
 *
 * Sheets belong to the group rather than to a shift, so this is loaded once
 * and reused across an entire window of occurrences. They used to sort
 * themselves by the rank they hung off; with no rank to sort by, `order` is
 * the group's own choice and this is what respects it.
 */
export async function loadSheets(groupId: string): Promise<LoadedSheet[]> {
    const rows = await db
        .select()
        .from(signupSheets)
        .where(and(eq(signupSheets.groupId, groupId), eq(signupSheets.enabled, true)))
        .orderBy(asc(signupSheets.order))

    if (rows.length === 0) return []

    const sheetIds = rows.map((row) => row.id)

    const slots = await db
        .select()
        .from(signupSlots)
        .where(inArray(signupSlots.sheetId, sheetIds))
        .orderBy(asc(signupSlots.order))

    // Both lists are read, not only the one in force: `uniformRanks` is a
    // toggle, and reading only the live side would mean a sheet flipped back
    // and forth loses whichever list was resting.
    const sheetRanks = await db
        .select({ sheetId: signupSheetRanks.sheetId, rankId: signupSheetRanks.rankId, name: rankRelations.cachedName })
        .from(signupSheetRanks)
        .innerJoin(rankRelations, eq(signupSheetRanks.rankId, rankRelations.id))
        .where(inArray(signupSheetRanks.sheetId, sheetIds))
        .orderBy(asc(rankRelations.cachedRank))

    const slotRanks =
        slots.length > 0
            ? await db
                  .select({
                      slotId: signupSlotRanks.slotId,
                      rankId: signupSlotRanks.rankId,
                      name: rankRelations.cachedName
                  })
                  .from(signupSlotRanks)
                  .innerJoin(rankRelations, eq(signupSlotRanks.rankId, rankRelations.id))
                  .where(
                      inArray(
                          signupSlotRanks.slotId,
                          slots.map((slot) => slot.id)
                      )
                  )
                  .orderBy(asc(rankRelations.cachedRank))
            : []

    return (
        rows
            .map((row) => {
                const own = sheetRanks.filter((rank) => rank.sheetId === row.id)

                return {
                    sheetId: row.id,
                    name: row.name,
                    description: row.description,
                    translations: presentTranslations('SHEET', row.translations),
                    color: row.color,
                    order: row.order,
                    uniformRanks: row.uniformRanks,
                    discordChannel: row.discordChannel,
                    discordPingRole: row.discordPingRole,
                    slots: slots
                        .filter((slot) => slot.sheetId === row.id)
                        .map((slot) => {
                            const ranks = row.uniformRanks
                                ? own
                                : slotRanks.filter((rank) => rank.slotId === slot.id)

                            return {
                                id: slot.id,
                                name: slot.name,
                                description: slot.description,
                                translations: presentTranslations('SLOT', slot.translations),
                                capacity: slot.capacity,
                                order: slot.order,
                                rankIds: ranks.map((rank) => rank.rankId),
                                rankNames: ranks.map((rank) => rank.name)
                            }
                        })
                }
            })
            // A sheet with nothing to sign up for is configuration in progress,
            // not something to show anyone.
            .filter((sheet) => sheet.slots.length > 0)
    )
}

/** The viewer, as the eligibility rule asks about them. */
export function viewerFor(membership: Membership, session: session): Viewer {
    return { membership, elevated: isSiteAdmin(session) }
}

/**
 * Trims sheets to the slots this viewer may see, dropping the sheets left
 * with nothing.
 *
 * Filtering happens per slot rather than per sheet, because a sheet is no
 * longer one rank's: one sheet can carry a driver slot and a dispatcher slot,
 * and sending the whole thing to whoever reaches either would publish the
 * other. A sheet whose every slot is hidden is not sent at all, so a client
 * never has to decide whether to draw an empty form.
 */
export function sheetsVisibleTo(sheets: LoadedSheet[], membership: Membership, session: session): LoadedSheet[] {
    const viewer = viewerFor(membership, session)

    return sheets
        .map((sheet) => ({ ...sheet, slots: sheet.slots.filter((slot) => canSeeSlot(slot.rankIds, viewer)) }))
        .filter((sheet) => sheet.slots.length > 0)
}

/**
 * When one occurrence's sign-ups open.
 *
 * Sheets used to sit on every occurrence the schedule could produce, months
 * out, which turned the shift page into a wall of empty forms and let people
 * commit to a shift nobody had planned yet. They open `signupLeadMinutes`
 * before the start and close at the end — a shift that has finished is not one
 * you can still put your name down for.
 */
export function signupsOpenAt(start: Date, leadMinutes: number): Date {
    return new Date(start.getTime() - leadMinutes * 60_000)
}

export function signupsOpen(start: Date, end: Date, leadMinutes: number, now = new Date()): boolean {
    return now >= signupsOpenAt(start, leadMinutes) && now < end
}

type SignupRow = {
    id: string
    slotId: string
    eventId: string
    occurrence: Date
    discordUserId: string | null
    discordUsername: string | null
    userId: string | null
    robloxId: number | null
    username: string | null
    displayName: string | null
    avatar: string | null
    linkedDiscordId: string | null
}

const bucketKey = (eventId: string, occurrence: Date, slotId: string) =>
    `${eventId}:${occurrence.getTime()}:${slotId}`

/**
 * Loads every signup for a set of slots across one window, indexed so
 * assembling occurrences never queries per occurrence.
 */
export async function loadSignups(
    slotIds: string[],
    eventIds: string[],
    from: Date,
    to: Date
): Promise<Map<string, ScheduleModel.signupUser[]>> {
    const index = new Map<string, ScheduleModel.signupUser[]>()
    if (slotIds.length === 0 || eventIds.length === 0) return index

    const rows: SignupRow[] = await db
        .select({
            // The row's own id, so somebody holding `EDIT_SIGNUPS` can name
            // one to move or remove without the caller having to reconstruct
            // an identity out of the two columns below.
            id: shiftSignups.id,
            slotId: shiftSignups.slotId,
            eventId: shiftSignups.eventId,
            occurrence: shiftSignups.occurrence,
            discordUserId: shiftSignups.discordUserId,
            discordUsername: shiftSignups.discordUsername,
            userId: users.id,
            robloxId: users.robloxId,
            username: users.cachedUsername,
            displayName: users.cachedDisplayName,
            avatar: users.cachedAvatar,
            linkedDiscordId: users.discordId
        })
        .from(shiftSignups)
        // A left join, not an inner one: a signup made from Discord by someone
        // with no TrPTools account has no user row to join to, and dropping it
        // would silently lose half the sheet.
        .leftJoin(users, eq(shiftSignups.userId, users.id))
        .where(
            and(
                inArray(shiftSignups.slotId, slotIds),
                inArray(shiftSignups.eventId, eventIds),
                gte(shiftSignups.occurrence, from),
                lte(shiftSignups.occurrence, to)
            )
        )

    for (const row of rows) {
        const key = bucketKey(row.eventId, row.occurrence, row.slotId)
        const bucket = index.get(key) ?? []

        bucket.push(
            row.userId
                ? {
                      id: row.id,
                      userId: row.userId,
                      robloxId: row.robloxId ?? 0,
                      username: row.username,
                      displayName: row.displayName,
                      avatar: row.avatar,
                      discordId: row.linkedDiscordId
                  }
                : {
                      id: row.id,
                      userId: '',
                      robloxId: 0,
                      username: row.discordUsername,
                      displayName: row.discordUsername,
                      avatar: null,
                      discordId: row.discordUserId
                  }
        )

        index.set(key, bucket)
    }

    return index
}

/**
 * Projects loaded sheets onto one occurrence, filling in who signed up.
 *
 * `canFill` travels per slot rather than being re-derived by the client: a
 * viewer holding `EDIT_SIGNUPS` sees slots they may not take themselves, and
 * without this the page would have to guess which of the two it is looking at.
 */
export function presentSheets(
    sheets: LoadedSheet[],
    eventId: string,
    occurrence: Date,
    signups: Map<string, ScheduleModel.signupUser[]>,
    viewer: Viewer
): ScheduleModel.signupSheet[] {
    return sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        name: sheet.name,
        description: sheet.description,
        translations: sheet.translations,
        color: sheet.color,
        slots: sheet.slots.map((slot) => ({
            id: slot.id,
            name: slot.name,
            description: slot.description,
            translations: slot.translations,
            capacity: slot.capacity,
            order: slot.order,
            rankNames: slot.rankNames,
            canFill: canFillSlot(slot.rankIds, viewer),
            signups: signups.get(bucketKey(eventId, occurrence, slot.id)) ?? []
        }))
    }))
}
