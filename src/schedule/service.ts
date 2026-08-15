import { status } from 'elysia'
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import db from '../db'
import { events, shiftSignups, shiftSlots, users, type Event, type ShiftSlot } from '../db/schema'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertPermission, GetPermissionLevel } from '../utils/groupPermission'
import { describeRule, isValidRule, occurrencesBetween } from '../utils/recurrence'
import { childSlug, uniqueWithin } from '../utils/slug'
import type { session } from '../utils/sessionVerifier'
import { findGroup, recordAudit } from '../groups/service'
import { GroupModel } from '../groups/model'
import { ScheduleModel } from './model'

const MAX_HORIZON_DAYS = 120

function presentEvent(event: Event, slots: ShiftSlot[]): ScheduleModel.eventResponse {
    return {
        ...event,
        recurrenceText: describeRule(event.rrule, event.startTime),
        slots: slots
            .filter((slot) => slot.eventId === event.eventId)
            .sort((a, b) => a.order - b.order)
            .map((slot) => ({
                id: slot.id,
                name: slot.name,
                description: slot.description,
                capacity: slot.capacity,
                order: slot.order
            }))
    }
}

/** A shift page address free within its group. */
async function freeShiftSlug(groupId: string, name: string, exceptId?: string): Promise<string> {
    const rows = await db.select({ eventId: events.eventId, slug: events.slug }).from(events).where(eq(events.groupId, groupId))
    const taken = new Set(rows.filter((row) => row.eventId !== exceptId).map((row) => row.slug))

    return uniqueWithin(childSlug('shift', name, rows.length + 1), taken)
}

/** Replaces an event's slots wholesale, preserving ids where names match. */
async function replaceSlots(eventId: string, slots: ScheduleModel.slotInput[]) {
    const existing = await db.select().from(shiftSlots).where(eq(shiftSlots.eventId, eventId))
    const byName = new Map(existing.map((slot) => [slot.name, slot]))
    const keep = new Set<string>()

    for (const [index, slot] of slots.entries()) {
        const match = byName.get(slot.name)
        const values = {
            name: slot.name,
            description: slot.description ?? '',
            capacity: slot.capacity ?? 1,
            order: slot.order ?? index
        }

        if (match) {
            // Reusing the row keeps existing signups attached.
            keep.add(match.id)
            await db.update(shiftSlots).set(values).where(eq(shiftSlots.id, match.id))
        } else {
            const [created] = await db
                .insert(shiftSlots)
                .values({ eventId, ...values })
                .returning({ id: shiftSlots.id })
            if (created) keep.add(created.id)
        }
    }

    const removed = existing.filter((slot) => !keep.has(slot.id))
    if (removed.length > 0) {
        await db.delete(shiftSlots).where(
            inArray(
                shiftSlots.id,
                removed.map((slot) => slot.id)
            )
        )
    }
}

/** Whether the caller may see a group's schedule at all. */
async function assertCanRead(groupIdOrSlug: string, session: session) {
    const group = await findGroup(groupIdOrSlug)
    if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

    const permissionLevel = session.user ? await GetPermissionLevel(session.user.userId, group.id) : PERMISSION.NONE
    const isMember = permissionLevel >= PERMISSION.DISPATCH || session.user?.siteRank === 'admin'

    if (!isMember && (group.visibility === 'PRIVATE' || !group.showShifts)) {
        throw status(404, 'Not Found' satisfies globalModel.notFound)
    }

    return { group, permissionLevel, isMember }
}

export abstract class Schedule {
    static async getSchedules(groupIdOrSlug: string, session: session): Promise<ScheduleModel.eventsResponse> {
        const { group, isMember } = await assertCanRead(groupIdOrSlug, session)

        const rows = await db
            .select()
            .from(events)
            .where(eq(events.groupId, group.id))
            .orderBy(asc(events.startTime))

        const visible = rows.filter((event) => isMember || event.visibility === 'PUBLIC')
        if (visible.length === 0) return []

        const slots = await db.select().from(shiftSlots).where(
            inArray(
                shiftSlots.eventId,
                visible.map((event) => event.eventId)
            )
        )

        return visible.map((event) => presentEvent(event, slots))
    }

    static async getScheduleObject(eventId: string, session: session): Promise<ScheduleModel.eventResponse> {
        const [event] = await db.select().from(events).where(eq(events.eventId, eventId)).limit(1)
        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const { isMember } = await assertCanRead(event.groupId, session)
        if (!isMember && event.visibility !== 'PUBLIC') {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const slots = await db.select().from(shiftSlots).where(eq(shiftSlots.eventId, eventId))

        return presentEvent(event, slots)
    }

    /**
     * Expands the group's recurring shifts into concrete occurrences over a
     * window and attaches everyone who signed up for each one.
     */
    static async getOccurrences(
        query: ScheduleModel.occurrencesRequest,
        session: session
    ): Promise<ScheduleModel.occurrencesResponse> {
        const { group, isMember } = await assertCanRead(query.groupId, session)

        const from = query.from ? new Date(query.from) : new Date()
        if (Number.isNaN(from.getTime())) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

        const requestedTo = query.to ? new Date(query.to) : new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000)
        if (Number.isNaN(requestedTo.getTime())) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

        // A caller must not be able to ask us to expand ten years of a rule.
        const horizon = new Date(from.getTime() + MAX_HORIZON_DAYS * 24 * 60 * 60 * 1000)
        const to = requestedTo > horizon ? horizon : requestedTo

        const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200)

        const rows = await db.select().from(events).where(eq(events.groupId, group.id))
        const visible = rows.filter((event) => isMember || event.visibility === 'PUBLIC')
        if (visible.length === 0) return []

        const slots = await db.select().from(shiftSlots).where(
            inArray(
                shiftSlots.eventId,
                visible.map((event) => event.eventId)
            )
        )

        const expanded: ScheduleModel.occurrencesResponse = []

        for (const event of visible) {
            const eventSlots = slots.filter((slot) => slot.eventId === event.eventId).sort((a, b) => a.order - b.order)

            for (const occurrence of occurrencesBetween(event.rrule, event.startTime, event.duration, from, to, limit)) {
                expanded.push({
                    eventId: event.eventId,
                    groupId: event.groupId,
                    name: event.name,
                    slug: event.slug,
                    description: event.description,
                    color: event.color,
                    start: occurrence.start,
                    end: occurrence.end,
                    slots: eventSlots.map((slot) => ({
                        id: slot.id,
                        name: slot.name,
                        description: slot.description,
                        capacity: slot.capacity,
                        order: slot.order,
                        signups: []
                    }))
                })
            }
        }

        expanded.sort((a, b) => a.start.getTime() - b.start.getTime())
        const window = expanded.slice(0, limit)
        if (window.length === 0) return []

        // Attach signups in one query rather than per occurrence.
        const slotIds = [...new Set(window.flatMap((entry) => entry.slots.map((slot) => slot.id)))]

        if (slotIds.length > 0) {
            const signups = await db
                .select({
                    slotId: shiftSignups.slotId,
                    occurrence: shiftSignups.occurrence,
                    userId: users.id,
                    robloxId: users.robloxId,
                    username: users.cachedUsername,
                    displayName: users.cachedDisplayName,
                    avatar: users.cachedAvatar
                })
                .from(shiftSignups)
                .innerJoin(users, eq(shiftSignups.userId, users.id))
                .where(
                    and(
                        inArray(shiftSignups.slotId, slotIds),
                        gte(shiftSignups.occurrence, window[0]!.start),
                        lte(shiftSignups.occurrence, window[window.length - 1]!.start)
                    )
                )

            const index = new Map<string, typeof signups>()
            for (const signup of signups) {
                const key = `${signup.slotId}:${signup.occurrence.getTime()}`
                const bucket = index.get(key) ?? []
                bucket.push(signup)
                index.set(key, bucket)
            }

            for (const entry of window) {
                for (const slot of entry.slots) {
                    const bucket = index.get(`${slot.id}:${entry.start.getTime()}`) ?? []
                    slot.signups = bucket.map((signup) => ({
                        userId: signup.userId,
                        robloxId: signup.robloxId,
                        username: signup.username,
                        displayName: signup.displayName,
                        avatar: signup.avatar
                    }))
                }
            }
        }

        return window
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

        const { slots, groupId, ...values } = body

        const [event] = await db
            .insert(events)
            .values({ ...values, groupId: group.id, slug: await freeShiftSlug(group.id, body.name) })
            .returning({ eventId: events.eventId })

        if (!event) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        if (slots?.length) await replaceSlots(event.eventId, slots)

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

        const { slots, ...patch } = body

        if (Object.keys(patch).length > 0) {
            await db
                .update(events)
                .set({
                    ...patch,
                    ...(patch.name !== undefined && patch.name !== event.name
                        ? { slug: await freeShiftSlug(event.groupId, patch.name, eventId) }
                        : {}),
                    updatedAt: new Date()
                })
                .where(eq(events.eventId, eventId))
        }

        if (slots !== undefined) await replaceSlots(eventId, slots)

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

    static async signUp(body: ScheduleModel.signupBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [slot] = await db
            .select({ slot: shiftSlots, event: events })
            .from(shiftSlots)
            .innerJoin(events, eq(shiftSlots.eventId, events.eventId))
            .where(eq(shiftSlots.id, body.slotId))
            .limit(1)

        if (!slot) throw status(404, 'Not Found' satisfies globalModel.notFound)

        // Signing up is a member action, so dispatch level is the floor.
        await assertPermission(session, slot.event.groupId, PERMISSION.DISPATCH)

        // Signing up for a time the shift does not actually run would create
        // orphan rows the scheduler never shows again.
        const matches = occurrencesBetween(
            slot.event.rrule,
            slot.event.startTime,
            slot.event.duration,
            new Date(body.occurrence.getTime() - 1000),
            new Date(body.occurrence.getTime() + 1000),
            1
        )

        if (matches.length === 0) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

        const existing = await db
            .select({ id: shiftSignups.id, userId: shiftSignups.userId })
            .from(shiftSignups)
            .where(and(eq(shiftSignups.slotId, body.slotId), eq(shiftSignups.occurrence, body.occurrence)))

        if (existing.some((row) => row.userId === session.user!.userId)) {
            throw status(409, 'already signed up for this shift' satisfies ScheduleModel.alreadySignedUp)
        }

        if (existing.length >= slot.slot.capacity) {
            throw status(409, 'that slot is full' satisfies ScheduleModel.slotFull)
        }

        await db.insert(shiftSignups).values({
            slotId: body.slotId,
            userId: session.user.userId,
            occurrence: body.occurrence
        })

        return 'Success' as globalModel.genericSuccess
    }

    static async withdraw(body: ScheduleModel.signupBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        await db
            .delete(shiftSignups)
            .where(
                and(
                    eq(shiftSignups.slotId, body.slotId),
                    eq(shiftSignups.occurrence, body.occurrence),
                    eq(shiftSignups.userId, session.user.userId)
                )
            )

        return 'Success' as globalModel.genericSuccess
    }
}
