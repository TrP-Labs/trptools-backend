import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import db from '../db'
import { rankRelations, rankSignups, rankSignupSlots, shiftSignups, users } from '../db/schema'
import { PERMISSION } from '../utils/globalModel'
import type { Membership } from '../utils/groupPermission'
import type { session } from '../utils/sessionVerifier'
import type { ScheduleModel } from './model'

/** A rank's sign-up sheet with its slots, before any occurrence is applied. */
export type LoadedSheet = {
    signupId: string
    rankId: string
    rankName: string
    robloxRank: number
    name: string
    description: string
    color: string
    discordChannel: string | null
    discordPingRole: string | null
    slots: Array<{
        id: string
        name: string
        description: string
        capacity: number
        order: number
    }>
}

/**
 * Every enabled sign-up sheet in a group, highest rank first.
 *
 * Sheets belong to ranks rather than shifts, so this is loaded once and reused
 * across an entire window of occurrences.
 */
export async function loadSheets(groupId: string): Promise<LoadedSheet[]> {
    const rows = await db
        .select({
            signupId: rankSignups.id,
            rankId: rankRelations.id,
            rankName: rankRelations.cachedName,
            robloxRank: rankRelations.cachedRank,
            name: rankSignups.name,
            description: rankSignups.description,
            color: rankSignups.color,
            discordChannel: rankSignups.discordChannel,
            discordPingRole: rankSignups.discordPingRole
        })
        .from(rankSignups)
        .innerJoin(rankRelations, eq(rankSignups.rankId, rankRelations.id))
        .where(and(eq(rankRelations.groupId, groupId), eq(rankSignups.enabled, true)))

    if (rows.length === 0) return []

    const slots = await db
        .select()
        .from(rankSignupSlots)
        .where(
            inArray(
                rankSignupSlots.signupId,
                rows.map((row) => row.signupId)
            )
        )
        .orderBy(asc(rankSignupSlots.order))

    return rows
        .map((row) => ({
            ...row,
            slots: slots
                .filter((slot) => slot.signupId === row.signupId)
                .map((slot) => ({
                    id: slot.id,
                    name: slot.name,
                    description: slot.description,
                    capacity: slot.capacity,
                    order: slot.order
                }))
        }))
        // A sheet with nothing to sign up for is configuration in progress,
        // not something to show anyone.
        .filter((sheet) => sheet.slots.length > 0)
        .sort((a, b) => b.robloxRank - a.robloxRank)
}

/**
 * Whether someone may see, and therefore fill, a sheet.
 *
 * Sign-ups are a staff feature: a sheet bound to a rank is for people holding
 * that rank or above, which is why this compares Roblox's own 0-255 ordering
 * rather than the coarse TrPTools permission level. A driver never sees the
 * dispatcher sheet.
 *
 * Managers and site admins see every sheet regardless — they are the people
 * who configure them, and a manager who happens to hold a low Roblox rank
 * still has to be able to staff a shift.
 */
export function canUseSheet(sheet: LoadedSheet, membership: Membership, session: session): boolean {
    if (session.user?.siteRank === 'admin') return true
    if (membership.permissionLevel >= PERMISSION.MANAGE) return true
    return membership.robloxRank >= sheet.robloxRank
}

export function sheetsVisibleTo(sheets: LoadedSheet[], membership: Membership, session: session): LoadedSheet[] {
    return sheets.filter((sheet) => canUseSheet(sheet, membership, session))
}

type SignupRow = {
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
                      userId: row.userId,
                      robloxId: row.robloxId ?? 0,
                      username: row.username,
                      displayName: row.displayName,
                      avatar: row.avatar,
                      discordId: row.linkedDiscordId
                  }
                : {
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

/** Projects loaded sheets onto one occurrence, filling in who signed up. */
export function presentSheets(
    sheets: LoadedSheet[],
    eventId: string,
    occurrence: Date,
    signups: Map<string, ScheduleModel.signupUser[]>
): ScheduleModel.signupSheet[] {
    return sheets.map((sheet) => ({
        signupId: sheet.signupId,
        rankId: sheet.rankId,
        rankName: sheet.rankName,
        robloxRank: sheet.robloxRank,
        name: sheet.name,
        description: sheet.description,
        color: sheet.color,
        slots: sheet.slots.map((slot) => ({
            id: slot.id,
            name: slot.name,
            description: slot.description,
            capacity: slot.capacity,
            order: slot.order,
            signups: signups.get(bucketKey(eventId, occurrence, slot.id)) ?? []
        }))
    }))
}
