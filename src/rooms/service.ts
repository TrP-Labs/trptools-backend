import { status } from 'elysia'
import { eq } from 'drizzle-orm'
import { encodeBase32LowerCaseNoPadding } from '@oslojs/encoding'
import db from '../db'
import { events } from '../db/schema'
import { dataRedis, deleteByPrefix } from '../utils/redis'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertPermission, GetPermissionLevel } from '../utils/groupPermission'
import { activeOccurrence } from '../utils/recurrence'
import type { session } from '../utils/sessionVerifier'
import { findGroup } from '../groups/service'
import { RoomModel } from './model'

export type RoomInfo = {
    groupId: string
    eventId: string
    eventName: string
    creatorId: string
    createdAt: string
    expiresAt: string
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

        await assertPermission(session, event.groupId, Math.max(event.hostLevel, PERMISSION.HOST))

        // The countdown on the dispatch page greys the button out until the
        // window opens; this is the same rule enforced where it counts.
        const group = await findGroup(event.groupId)
        const lead = group?.roomOpenLeadMinutes ?? 10

        const occurrence = activeOccurrence(event.rrule, event.startTime, event.duration, lead)
        if (!occurrence) {
            throw status(409, 'this shift is not running right now' satisfies RoomModel.notScheduled)
        }

        const roomId = generateRoomId()

        // SET NX is what makes "one room per group" a race-free guarantee.
        const claimed = await dataRedis.set(groupIndexKey(event.groupId), roomId, 'EX', 60 * 60 * 6, 'NX')
        if (!claimed) {
            throw status(409, 'this group already has a room open' satisfies RoomModel.alreadyOpen)
        }

        // Keep the room alive until the shift ends, plus an hour of slack for
        // overruns, and never less than 30 minutes.
        const ttlSeconds = Math.max(
            Math.ceil((occurrence.end.getTime() - Date.now()) / 1000) + 3600,
            1800
        )

        const info: RoomInfo = {
            groupId: event.groupId,
            eventId: event.eventId,
            eventName: event.name,
            creatorId: session.user.userId,
            createdAt: Date.now().toString(),
            expiresAt: occurrence.end.getTime().toString()
        }

        await dataRedis.hset(roomKey(roomId), info)
        await dataRedis.expire(roomKey(roomId), ttlSeconds)
        await dataRedis.expire(groupIndexKey(event.groupId), ttlSeconds)

        return { roomId }
    }

    /** The room currently open for a group, if any. */
    static async getId(groupIdOrSlug: string, session: session): Promise<RoomModel.roomResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, group.id, PERMISSION.DISPATCH)

        const roomId = await dataRedis.get(groupIndexKey(group.id))
        if (!roomId) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return { roomId }
    }

    static async getRoomInfo(roomId: string, session: session): Promise<RoomModel.activeRoomResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const info = await requireRoom(roomId)
        await assertPermission(session, info.groupId, PERMISSION.DISPATCH)

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
        await assertPermission(session, info.groupId, PERMISSION.HOST)

        await Promise.all([
            dataRedis.del(groupIndexKey(info.groupId)),
            deleteByPrefix(roomKey(roomId)),
            deleteByPrefix(`dispatchroom:${roomId}`)
        ])

        return 'Success' as globalModel.genericSuccess
    }
}

/** Shared by the dispatch controller: can this user act in this room? */
export async function canDispatch(
    user: { userId: string; siteRank: string },
    roomId: string
): Promise<RoomInfo | null> {
    const groupId = await dataRedis.hget(roomKey(roomId), 'groupId')
    if (!groupId) return null

    if (user.siteRank !== 'admin') {
        const level = await GetPermissionLevel(user.userId, groupId)
        if (level < PERMISSION.DISPATCH) return null
    }

    return requireRoom(roomId)
}
