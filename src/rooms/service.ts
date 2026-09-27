import { status } from 'elysia'
import { eq } from 'drizzle-orm'
import { encodeBase32LowerCaseNoPadding } from '@oslojs/encoding'
import db from '../db'
import { events, botConfigs } from '../db/schema'
import { dataRedis, deleteByPrefix } from '../utils/redis'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertGroupPermission, assertAnyGroupPermission, GetMembership } from '../utils/groupPermission'
import { has, PERM } from '../utils/permissions'
import { activeOccurrence } from '../utils/recurrence'
import { isElevated, type session, type SessionUser } from '../utils/sessionVerifier'
import { findGroup } from '../groups/service'
import { runBatches, assertResults } from './dispatch/batch'
import { makeTimeline, DEFAULT_SCHEDULE } from '../host/rules'
import { RoomModel } from './model'
import { CREATE_ROOM, TOUCH_ROOM } from './lifecycle'
import { CLOSE_ROOM } from './dispatch/redisScripts'

export type RoomInfo = {
    groupId: string
    eventId: string
    eventName: string
    creatorId: string
    createdAt: string
    expiresAt: string
    occurrence: string
    activeUntil: string
    startAt: string
    timeline: string
}

export function generateRoomId(): string {
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    return encodeBase32LowerCaseNoPadding(bytes)
}

export const roomKey = (roomId: string) => `room:${roomId}`
export const groupIndexKey = (groupId: string) => `groupindex:${groupId}`
export const roomUsersKey = (roomId: string) => `dispatchroom:${roomId}:users`
export const roomVehiclesKey = (roomId: string) => `dispatchroom:${roomId}:vehicles`
export const roomChannel = (roomId: string) => `dispatchroom.${roomId}`

/** Reads a room, or throws 404 if it has closed or expired. */
export async function touchRoom(roomId: string) {
    return dataRedis.eval<number>(TOUCH_ROOM, [roomKey(roomId), roomUsersKey(roomId)],
        [String(Date.now()), roomId, roomChannel(roomId)])
}

export async function requireRoom(roomId: string): Promise<RoomInfo> {
    const info = (await dataRedis.hgetall(roomKey(roomId))) as Partial<RoomInfo>
    if (!info || Object.keys(info).length === 0) {
        throw status(404, 'Not Found' satisfies globalModel.notFound)
    }
    return info as RoomInfo
}

export abstract class RoomControls {
    /**
     * Opens a dispatch room for a shift that is running right now.
     *
     * Rooms are keyed by group so two hosts cannot split a shift in half, and
     * they live in Redis with a TTL tied to the shift's end so an abandoned
     * room cleans itself up.
     */
    static async createRoom(body: RoomModel.openBody, session: session): Promise<RoomModel.roomResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [event] = await db.select().from(events).where(eq(events.eventId, body.eventId)).limit(1)
        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        // Two questions, and both have to hold: may this rank open rooms at
        // all, and does this particular shift ask for more standing than the
        // group's default (`events.hostLevel`).
        await assertGroupPermission(session, event.groupId, PERM.START_ROOM, event.hostLevel)

        // The countdown on the dispatch page greys the button out until the
        // window opens; this is the same rule enforced where it counts.
        const group = await findGroup(event.groupId)
        const lead = group?.roomOpenLeadMinutes ?? 10

        const occurrence = activeOccurrence(event.rrule, event.startTime, event.duration, lead, new Date(), 30)
        if (!occurrence) {
            throw status(409, 'this shift is not running right now' satisfies RoomModel.notScheduled)
        }

        const roomId = generateRoomId()

        // An empty room expires exactly when its occurrence's wrap-up ends.
        // Presence heartbeats extend this TTL while staff are still connected.
        const ttlSeconds = Math.max(1, Math.ceil((occurrence.end.getTime() + 1800000 - Date.now()) / 1000))

        const [config] = await db.select().from(botConfigs).where(eq(botConfigs.groupId, event.groupId)).limit(1)
        const enabled = { STAFF_START: Boolean(config?.signupsEnabled && config.autoStaffStart), BEGIN: Boolean(config?.announcementsEnabled && config.autoBegin), COMPLETE: Boolean(config?.autoComplete) }
        const storedNote = await dataRedis.get(`shiftnote:${event.eventId}:${occurrence.start.getTime()}`)
        let note: {note?:string;ownerRobloxId?:string|null;imageUrl?:string|null} = {}
        try { note = storedNote ? JSON.parse(storedNote) : {} } catch { /* Old malformed notes must not prevent opening the room. */ }
        const timeline = makeTimeline(group?.hostSchedule ?? DEFAULT_SCHEDULE, occurrence.start.getTime(), occurrence.end.getTime(), enabled)
        const completed = await runBatches(dataRedis, timeline.map(item => pipeline => pipeline.eval("return redis.call('GET', KEYS[1])", [`bot:done:${item.action}:${event.eventId}:${occurrence.start.getTime()}`], [])))
        assertResults(completed)
        completed.forEach(([,value],index) => { if (value) timeline[index]!.status = value === 'STAFF' ? 'ACTIVATED' : 'AUTOMATED' })
        const info: RoomInfo & Record<string,string> = {
            botConnected: String(Boolean(config)),
            note: note.note ?? '', ownerRobloxId: note.ownerRobloxId ?? '', imageUrl: note.imageUrl ?? '',
            groupId: event.groupId,
            eventId: event.eventId,
            eventName: event.name,
            creatorId: session.user.userId,
            createdAt: Date.now().toString(),
            expiresAt: occurrence.end.getTime().toString(),
            occurrence: occurrence.start.toISOString(),
            activeUntil: String(occurrence.end.getTime() + 30 * 60_000),
            startAt: String(occurrence.start.getTime()),
            timeline: JSON.stringify(timeline)
        }

        const claimed = await dataRedis.eval<number>(CREATE_ROOM,
            [roomKey(roomId), groupIndexKey(event.groupId)], [roomId, JSON.stringify(info), String(ttlSeconds)])
        if (!claimed) throw status(409, 'this group already has a room open' satisfies RoomModel.alreadyOpen)

        return { roomId }
    }

    /** The room currently open for a group, if any. */
    static async getId(groupIdOrSlug: string, session: session): Promise<RoomModel.roomResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertAnyGroupPermission(session, group.id, [PERM.DISPATCH, PERM.START_ROOM])

        const roomId = await dataRedis.get(groupIndexKey(group.id))
        if (!roomId || !await touchRoom(roomId)) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return { roomId }
    }

    static async getRoomInfo(roomId: string, session: session): Promise<RoomModel.activeRoomResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const info = await requireRoom(roomId)
        await assertAnyGroupPermission(session, info.groupId, [PERM.DISPATCH, PERM.START_ROOM])

        const [dispatchers, vehicles] = await Promise.all([
            dataRedis.hgetall(roomUsersKey(roomId)),
            dataRedis.llen(roomVehiclesKey(roomId))
        ])

        return {
            roomId,
            groupId: info.groupId,
            eventId: info.eventId,
            eventName: info.eventName,
            createdAt: new Date(Number(info.createdAt)),
            expiresAt: new Date(Number(info.expiresAt)),
            creatorId: info.creatorId,
            // Presence is stored as a per-user count of open streams.
            users: Object.entries(dispatchers)
                .filter(([, value]) => Number(value) > 0)
                .map(([userId]) => userId),
            vehicles
        }
    }

    static async closeRoom(roomId: string, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const info = await requireRoom(roomId)
        await assertGroupPermission(session, info.groupId, Date.now() < Number(info.activeUntil ?? Number(info.expiresAt) + 1800000) ? PERM.CLOSE_ROOM : PERM.START_ROOM)

        await dataRedis.eval(CLOSE_ROOM, [roomKey(roomId), groupIndexKey(info.groupId)], [roomId, roomChannel(roomId)])
        await deleteByPrefix(`dispatchroom:${roomId}:`)

        return 'Success' as globalModel.genericSuccess
    }
}

/** Shared by the dispatch controller: can this user act in this room? */
export async function canDispatch(user: SessionUser, roomId: string): Promise<RoomInfo | null> {
    const info = await dataRedis.hgetall(roomKey(roomId)) as Partial<RoomInfo>
    if (!info.groupId) return null

    if (!isElevated(user)) {
        const membership = await GetMembership(user.userId, info.groupId)
        if (!has(membership.permissions, PERM.DISPATCH) && !has(membership.permissions, PERM.START_ROOM)) return null
    }

    return info as RoomInfo
}
