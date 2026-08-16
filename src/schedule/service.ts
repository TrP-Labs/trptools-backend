import { status } from 'elysia'
import { and, asc, eq } from 'drizzle-orm'
import db from '../db'
import { events, rankSignupSlots, shiftSignups, type Event } from '../db/schema'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertPermission, GetMembership } from '../utils/groupPermission'
import { describeRule, isValidRule, occurrencesBetween } from '../utils/recurrence'
import { childSlug, uniqueWithin } from '../utils/slug'
import type { session } from '../utils/sessionVerifier'
import { findGroup, recordAudit } from '../groups/service'
import { GroupModel } from '../groups/model'
import { publishSignupChange } from './events'
import { canUseSheet, loadSheets, loadSignups, presentSheets, sheetsVisibleTo } from './sheets'
import { ScheduleModel } from './model'

const MAX_HORIZON_DAYS = 120

function presentEvent(event: Event): ScheduleModel.eventResponse {
    return { ...event, recurrenceText: describeRule(event.rrule, event.startTime) }
}

/** A shift page address free within its group. */
async function freeShiftSlug(groupId: string, name: string, exceptId?: string): Promise<string> {
    const rows = await db.select({ eventId: events.eventId, slug: events.slug }).from(events).where(eq(events.groupId, groupId))
    const taken = new Set(rows.filter((row) => row.eventId !== exceptId).map((row) => row.slug))

    return uniqueWithin(childSlug('shift', name, rows.length + 1), taken)
}

/** Whether the caller may see a group's schedule at all. */
async function assertCanRead(groupIdOrSlug: string, session: session) {
    const group = await findGroup(groupIdOrSlug)
    if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

    const membership = session.user
        ? await GetMembership(session.user.userId, group.id)
        : { permissionLevel: PERMISSION.NONE, robloxRank: -1 }

    const isMember = membership.permissionLevel >= PERMISSION.DISPATCH || session.user?.siteRank === 'admin'

    if (!isMember && (group.visibility === 'PRIVATE' || !group.showShifts)) {
        throw status(404, 'Not Found' satisfies globalModel.notFound)
    }

    return { group, membership, isMember }
}

export abstract class Schedule {
    static async getSchedules(groupIdOrSlug: string, session: session): Promise<ScheduleModel.eventsResponse> {
        const { group, isMember } = await assertCanRead(groupIdOrSlug, session)

        const rows = await db
            .select()
            .from(events)
            .where(eq(events.groupId, group.id))
            .orderBy(asc(events.startTime))

        return rows.filter((event) => isMember || event.visibility === 'PUBLIC').map(presentEvent)
    }

    static async getScheduleObject(eventId: string, session: session): Promise<ScheduleModel.eventResponse> {
        const [event] = await db.select().from(events).where(eq(events.eventId, eventId)).limit(1)
        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const { isMember } = await assertCanRead(event.groupId, session)
        if (!isMember && event.visibility !== 'PUBLIC') {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        return presentEvent(event)
    }

    /**
     * Expands the group's recurring shifts into concrete occurrences over a
     * window and attaches the sign-up sheets the caller is allowed to see.
     */
    static async getOccurrences(
        query: ScheduleModel.occurrencesRequest,
        session: session
    ): Promise<ScheduleModel.occurrencesResponse> {
        const { group, membership, isMember } = await assertCanRead(query.groupId, session)

        const from = query.from ? new Date(query.from) : new Date()
        if (Number.isNaN(from.getTime())) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

        const requestedTo = query.to ? new Date(query.to) : new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000)
        if (Number.isNaN(requestedTo.getTime())) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

        // A caller must not be able to ask us to expand ten years of a rule.
        const horizon = new Date(from.getTime() + MAX_HORIZON_DAYS * 24 * 60 * 60 * 1000)
        const to = requestedTo > horizon ? horizon : requestedTo

        const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200)

        const rows = await db.select().from(events).where(eq(events.groupId, group.id))

        const visible = rows.filter(
            (event) =>
                (isMember || event.visibility === 'PUBLIC') && (!query.eventId || event.eventId === query.eventId)
        )
        if (visible.length === 0) return []

        const expanded = visible.flatMap((event) =>
            occurrencesBetween(event.rrule, event.startTime, event.duration, from, to, limit).map((occurrence) => ({
                event,
                occurrence
            }))
        )

        expanded.sort((a, b) => a.occurrence.start.getTime() - b.occurrence.start.getTime())
        const window = expanded.slice(0, limit)
        if (window.length === 0) return []

        // Sheets are per rank, so they are loaded once for the whole window
        // rather than per occurrence.
        const sheets = isMember ? sheetsVisibleTo(await loadSheets(group.id), membership, session) : []

        const signups =
            sheets.length > 0
                ? await loadSignups(
                      sheets.flatMap((sheet) => sheet.slots.map((slot) => slot.id)),
                      [...new Set(window.map((entry) => entry.event.eventId))],
                      window[0]!.occurrence.start,
                      window[window.length - 1]!.occurrence.start
                  )
                : new Map()

        return window.map(({ event, occurrence }) => ({
            eventId: event.eventId,
            groupId: event.groupId,
            name: event.name,
            slug: event.slug,
            description: event.description,
            color: event.color,
            start: occurrence.start,
            end: occurrence.end,
            sheets: presentSheets(sheets, event.eventId, occurrence.start, signups)
        }))
    }

    static async createScheduledObject(
        body: ScheduleModel.createBody,
        session: session
    ): Promise<ScheduleModel.createResponse> {
        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        if (!isValidRule(body.rrule)) {
            throw status(400, 'invalid recurrence rule' satisfies ScheduleModel.invalidRRule)
        }

        const { groupId, ...values } = body

        const [event] = await db
            .insert(events)
            .values({ ...values, groupId: group.id, slug: await freeShiftSlug(group.id, body.name) })
            .returning({ eventId: events.eventId })

        if (!event) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        await recordAudit(group.id, session.user?.userId ?? null, 'shift.create', `Created shift ${body.name}`)

        return { eventId: event.eventId }
    }

    static async updateScheduleObject(eventId: string, body: ScheduleModel.updateBody, session: session) {
        const [event] = await db.select().from(events).where(eq(events.eventId, eventId)).limit(1)
        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, event.groupId, PERMISSION.MANAGE)

        if (body.rrule !== undefined && !isValidRule(body.rrule)) {
            throw status(400, 'invalid recurrence rule' satisfies ScheduleModel.invalidRRule)
        }

        if (Object.keys(body).length > 0) {
            await db
                .update(events)
                .set({
                    ...body,
                    ...(body.name !== undefined && body.name !== event.name
                        ? { slug: await freeShiftSlug(event.groupId, body.name, eventId) }
                        : {}),
                    updatedAt: new Date()
                })
                .where(eq(events.eventId, eventId))
        }

        await recordAudit(event.groupId, session.user?.userId ?? null, 'shift.update', `Updated shift ${event.name}`)

        return 'Success' as globalModel.genericSuccess
    }

    static async deleteScheduleObject(eventId: string, session: session) {
        const [event] = await db.select().from(events).where(eq(events.eventId, eventId)).limit(1)
        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, event.groupId, PERMISSION.MANAGE)

        await db.delete(events).where(eq(events.eventId, eventId))

        await recordAudit(event.groupId, session.user?.userId ?? null, 'shift.delete', `Deleted shift ${event.name}`)

        return 'Success' as globalModel.genericSuccess
    }

    // ---------------------------------------------------------------- signups

    /**
     * Resolves a slot to the shift it is being taken against, checking that
     * the caller's rank actually reaches the sheet the slot belongs to and
     * that the occurrence is one the shift really runs.
     */
    private static async resolveSlot(body: ScheduleModel.signupBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [event] = await db.select().from(events).where(eq(events.eventId, body.eventId)).limit(1)
        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const membership = await GetMembership(session.user.userId, event.groupId)

        // Signing up is a member action, so dispatch level is the floor.
        if (membership.permissionLevel < PERMISSION.DISPATCH && session.user.siteRank !== 'admin') {
            throw status(403, 'Forbidden' satisfies globalModel.forbidden)
        }

        const sheets = await loadSheets(event.groupId)
        const sheet = sheets.find((candidate) => candidate.slots.some((slot) => slot.id === body.slotId))
        if (!sheet) throw status(404, 'Not Found' satisfies globalModel.notFound)

        if (!canUseSheet(sheet, membership, session)) {
            throw status(403, 'your rank cannot take that slot' satisfies ScheduleModel.wrongRank)
        }

        const slot = sheet.slots.find((candidate) => candidate.id === body.slotId)!

        // Signing up for a time the shift does not actually run would create
        // orphan rows the scheduler never shows again.
        const matches = occurrencesBetween(
            event.rrule,
            event.startTime,
            event.duration,
            new Date(body.occurrence.getTime() - 1000),
            new Date(body.occurrence.getTime() + 1000),
            1
        )

        if (matches.length === 0) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

        return { event, sheet, slot }
    }

    static async signUp(body: ScheduleModel.signupBody, session: session) {
        const { event, sheet, slot } = await Schedule.resolveSlot(body, session)

        const existing = await db
            .select({ id: shiftSignups.id, userId: shiftSignups.userId })
            .from(shiftSignups)
            .where(
                and(
                    eq(shiftSignups.slotId, body.slotId),
                    eq(shiftSignups.eventId, body.eventId),
                    eq(shiftSignups.occurrence, body.occurrence)
                )
            )

        if (existing.some((row) => row.userId === session.user!.userId)) {
            throw status(409, 'already signed up for this shift' satisfies ScheduleModel.alreadySignedUp)
        }

        if (existing.length >= slot.capacity) {
            throw status(409, 'that slot is full' satisfies ScheduleModel.slotFull)
        }

        await db.insert(shiftSignups).values({
            slotId: body.slotId,
            eventId: body.eventId,
            userId: session.user!.userId,
            occurrence: body.occurrence
        })

        await publishSignupChange(event.groupId, body.eventId, body.occurrence, sheet.signupId)

        return 'Success' as globalModel.genericSuccess
    }

    static async withdraw(body: ScheduleModel.signupBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [removed] = await db
            .delete(shiftSignups)
            .where(
                and(
                    eq(shiftSignups.slotId, body.slotId),
                    eq(shiftSignups.eventId, body.eventId),
                    eq(shiftSignups.occurrence, body.occurrence),
                    eq(shiftSignups.userId, session.user.userId)
                )
            )
            .returning({ id: shiftSignups.id })

        if (removed) {
            const [event] = await db
                .select({ groupId: events.groupId })
                .from(events)
                .where(eq(events.eventId, body.eventId))
                .limit(1)

            const [slot] = await db
                .select({ signupId: rankSignupSlots.signupId })
                .from(rankSignupSlots)
                .where(eq(rankSignupSlots.id, body.slotId))
                .limit(1)

            if (event && slot) {
                await publishSignupChange(event.groupId, body.eventId, body.occurrence, slot.signupId)
            }
        }

        return 'Success' as globalModel.genericSuccess
    }
}
