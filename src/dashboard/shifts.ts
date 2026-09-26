import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import db from '../db'
import {
    events, groups, shiftSignups, signupSheetRanks, signupSheets, signupSlotRanks, signupSlots,
    type Event
} from '../db/schema'
import type { GroupModel } from '../groups/model'
import { canSeeSlot } from '../schedule/eligibility'
import { signupsOpen } from '../schedule/sheets'
import { isGroupMember, type Membership } from '../utils/membershipRule'
import { occurrencesBetween } from '../utils/recurrence'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { presentTranslations } from '../utils/translations'
import type { DashboardModel } from './model'

type WindowEntry = {
    event: Event
    group: GroupModel.groupSummary
    leadMinutes: number
    start: Date
    end: Date
}

type VisibleSlot = { id: string; capacity: number }

const signupKey = (eventId: string, start: Date, slotId: string) =>
    `${eventId}:${start.getTime()}:${slotId}`

/**
 * The home page needs counts, not complete signup forms. Read all its groups'
 * events, visible slots and signup counts in three batched database queries.
 * Memberships still use the one-minute permission cache, fetched with MGET.
 */
export async function dashboardSchedules(
    groupsOnPage: GroupModel.groupSummary[],
    session: session,
    membershipsPromise: Promise<Map<string, Membership>>,
    from: Date,
    to: Date,
    perGroup: number,
    eventCounts?: Map<string, number>
): Promise<DashboardModel.upcomingShift[][]> {
    if (!session.user || groupsOnPage.length === 0) return groupsOnPage.map(() => [])

    const groupIds = groupsOnPage.map((group) => group.id)
    const [memberships, rows] = await Promise.all([
        membershipsPromise,
        db.select({
            event: events,
            visibility: groups.visibility,
            showShifts: groups.showShifts,
            leadMinutes: groups.signupLeadMinutes
        })
            .from(events)
            .innerJoin(groups, eq(events.groupId, groups.id))
            .where(inArray(events.groupId, groupIds))
    ])

    const elevated = isSiteAdmin(session)

    const groupById = new Map(groupsOnPage.map((group) => [group.id, group]))
    const windows = new Map<string, WindowEntry[]>(groupIds.map((id) => [id, []]))
    for (const row of rows) {
        const group = groupById.get(row.event.groupId)!
        const isMember = elevated || isGroupMember(memberships.get(group.id)!)
        if (!isMember && (row.visibility === 'PRIVATE' || !row.showShifts || row.event.visibility !== 'PUBLIC')) {
            continue
        }

        eventCounts?.set(group.id, (eventCounts.get(group.id) ?? 0) + 1)
        const bucket = windows.get(group.id)!
        // Include starts early enough for this event to still be running.
        const searchFrom = new Date(from.getTime() - row.event.duration * 60_000)
        for (const occurrence of occurrencesBetween(
            row.event.rrule, row.event.startTime, row.event.duration, searchFrom, to, perGroup + 1
        )) {
            if (occurrence.end <= from) continue
            bucket.push({
                event: row.event,
                group,
                leadMinutes: row.leadMinutes,
                start: occurrence.start,
                end: occurrence.end
            })
        }
    }

    for (const bucket of windows.values()) {
        bucket.sort((a, b) => a.start.getTime() - b.start.getTime())
        bucket.length = Math.min(bucket.length, perGroup)
    }

    const memberGroupIds = groupIds.filter((id) =>
        windows.get(id)!.length > 0 && (elevated || isGroupMember(memberships.get(id)!))
    )
    const allSlots = new Map<string, { groupId: string; capacity: number; rankIds: Set<string> }>()

    if (memberGroupIds.length > 0) {
        // Only the rank list in force joins each slot. This avoids four serial
        // sheet queries per group and never loads names or translations that
        // the home card cannot display.
        const slotRows = await db.select({
            groupId: signupSheets.groupId,
            slotId: signupSlots.id,
            capacity: signupSlots.capacity,
            rankId: sql<string | null>`coalesce(${signupSheetRanks.rankId}, ${signupSlotRanks.rankId})`
        })
            .from(signupSheets)
            .innerJoin(signupSlots, eq(signupSlots.sheetId, signupSheets.id))
            .leftJoin(signupSheetRanks, and(
                eq(signupSheets.uniformRanks, true), eq(signupSheetRanks.sheetId, signupSheets.id)
            ))
            .leftJoin(signupSlotRanks, and(
                eq(signupSheets.uniformRanks, false), eq(signupSlotRanks.slotId, signupSlots.id)
            ))
            .where(and(eq(signupSheets.enabled, true), inArray(signupSheets.groupId, memberGroupIds)))

        for (const row of slotRows) {
            let slot = allSlots.get(row.slotId)
            if (!slot) {
                slot = { groupId: row.groupId, capacity: row.capacity, rankIds: new Set() }
                allSlots.set(row.slotId, slot)
            }
            if (row.rankId) slot.rankIds.add(row.rankId)
        }
    }

    const visibleSlots = new Map<string, VisibleSlot[]>(groupIds.map((id) => [id, []]))
    for (const [id, slot] of allSlots) {
        const membership = memberships.get(slot.groupId)
        if (elevated || (membership && canSeeSlot([...slot.rankIds], { membership, elevated }))) {
            visibleSlots.get(slot.groupId)!.push({ id, capacity: slot.capacity })
        }
    }

    const openEntries = [...windows.values()].flat().filter((entry) =>
        visibleSlots.get(entry.group.id)!.length > 0 && signupsOpen(entry.start, entry.end, entry.leadMinutes, from)
    )
    const signupCounts = new Map<string, { filled: number; signedUp: boolean }>()

    if (openEntries.length > 0) {
        const slotIds = [...new Set(openEntries.flatMap((entry) => visibleSlots.get(entry.group.id)!.map((slot) => slot.id)))]
        const eventIds = [...new Set(openEntries.map((entry) => entry.event.eventId))]
        const starts = openEntries.map((entry) => entry.start.getTime())
        const counts = await db.select({
            eventId: shiftSignups.eventId,
            occurrence: shiftSignups.occurrence,
            slotId: shiftSignups.slotId,
            filled: count(shiftSignups.id),
            signedUp: sql<boolean>`coalesce(bool_or(${shiftSignups.userId} = ${session.user.userId}), false)`
        })
            .from(shiftSignups)
            .where(and(
                inArray(shiftSignups.slotId, slotIds),
                inArray(shiftSignups.eventId, eventIds),
                gte(shiftSignups.occurrence, new Date(Math.min(...starts))),
                lte(shiftSignups.occurrence, new Date(Math.max(...starts)))
            ))
            .groupBy(shiftSignups.eventId, shiftSignups.occurrence, shiftSignups.slotId)

        for (const row of counts) {
            signupCounts.set(signupKey(row.eventId, row.occurrence, row.slotId), {
                filled: Number(row.filled), signedUp: row.signedUp
            })
        }
    }

    return groupsOnPage.map((group) => (windows.get(group.id) ?? []).map((entry) => {
        const open = signupsOpen(entry.start, entry.end, entry.leadMinutes, from)
        const slots = open ? visibleSlots.get(group.id)! : []
        let filled = 0
        let signedUp = false
        for (const slot of slots) {
            const count = signupCounts.get(signupKey(entry.event.eventId, entry.start, slot.id))
            filled += count?.filled ?? 0
            signedUp ||= count?.signedUp ?? false
        }

        return {
            eventId: entry.event.eventId,
            name: entry.event.name,
            translations: presentTranslations('SHIFT', entry.event.translations),
            slug: entry.event.slug,
            color: entry.event.color,
            start: entry.start,
            end: entry.end,
            groupId: group.id,
            groupSlug: group.slug,
            groupName: group.name,
            groupTranslations: group.translations,
            groupIcon: group.icon,
            signedUp,
            signupsOpen: open,
            sheetsAvailable: visibleSlots.get(group.id)!.length > 0,
            filled,
            capacity: slots.reduce((total, slot) => total + slot.capacity, 0)
        }
    }))
}
