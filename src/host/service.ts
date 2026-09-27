import { status } from 'elysia'
import { eq } from 'drizzle-orm'
import db from '../db'
import { groups, botConfigs } from '../db/schema'
import { findGroup, recordAudit } from '../groups/service'
import {
    assertGroupPermission,
    assertAnyGroupPermission,
    GetMembership,
} from '../utils/groupPermission'
import { has, PERM } from '../utils/permissions'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { dataRedis } from '../utils/redis'
import {
    roomKey,
    roomChannel,
    groupIndexKey,
    requireRoom,
} from '../rooms/service'
import { MediaService } from '../media/service'
import { HostModel } from './model'
import { DEFAULT_SCHEDULE, validSchedule, BOT_ACTIONS } from './rules'
import {
    CHANGE_EVENT,
    EXTEND_HOST,
    SET_NOTE,
    CLAIM_TIMELINE,
} from './redisScripts'

export async function hostSnapshot(
    roomId: string,
): Promise<HostModel.Snapshot> {
    const raw = await dataRedis.eval<string | null>(
        CLAIM_TIMELINE,
        [roomKey(roomId)],
        [String(Date.now()), roomId, roomChannel(roomId), 'READ'],
    )
    if (!raw) throw status(404, 'Not Found')
    return JSON.parse(raw)
}
export abstract class Host {
    static async schedule(groupId: string, session: session) {
        const group = await findGroup(groupId)
        if (!group) throw status(404, 'Not Found')
        await assertAnyGroupPermission(session, group.id, [
            PERM.START_ROOM,
            PERM.MANAGE_SHIFTS,
        ])
        return group.hostSchedule ?? DEFAULT_SCHEDULE
    }
    static async saveSchedule(
        groupId: string,
        body: HostModel.Schedule,
        session: session,
    ) {
        const group = await findGroup(groupId)
        if (!group) throw status(404, 'Not Found')
        await assertGroupPermission(session, group.id, PERM.MANAGE_SHIFTS)
        if (!validSchedule(body)) throw status(400, 'Bad Request')
        await db
            .update(groups)
            .set({ hostSchedule: body })
            .where(eq(groups.id, group.id))
        await recordAudit(
            group.id,
            session.user!.userId,
            'HOST_SCHEDULE',
            'Updated host schedule',
        )
        return 'Success' as const
    }
    static async get(roomId: string, session: session) {
        if (!session.user) throw status(401, 'Unauthorized')
        // The atomic snapshot already carries the room's group. Reading the
        // complete Redis hash first duplicates both the transfer and parsing.
        const snapshot = await hostSnapshot(roomId)
        await assertAnyGroupPermission(session, snapshot.groupId, [
            PERM.START_ROOM,
            PERM.DISPATCH,
        ])
        return snapshot
    }
    static async extend(roomId: string, minutes: number, session: session) {
        const info = await requireRoom(roomId)
        await assertGroupPermission(session, info.groupId, PERM.START_ROOM)
        const raw = await dataRedis.eval<string | null>(
            EXTEND_HOST,
            [roomKey(roomId), groupIndexKey(info.groupId)],
            [String(Date.now()), roomId, roomChannel(roomId), String(minutes)],
        )
        if (!raw) throw status(404, 'Not Found')
        return JSON.parse(raw) as HostModel.Snapshot
    }
    static async event(
        roomId: string,
        id: string,
        body: typeof HostModel.eventBody.static,
        session: session,
    ) {
        const info = await requireRoom(roomId)
        if (!session.user) throw status(401, 'Unauthorized')
        const permissions = isSiteAdmin(session)
            ? PERM.ADMINISTRATOR
            : (await GetMembership(session.user!.userId, info.groupId))
                  .permissions
        if (
            !has(permissions, PERM.START_ROOM) &&
            !has(permissions, PERM.DISPATCH)
        )
            throw status(403, 'Forbidden')
        if (
            body.operation !== 'ACKNOWLEDGE' &&
            !has(permissions, PERM.START_ROOM)
        )
            throw status(403, 'Forbidden')
        if (
            body.operation === 'RESCHEDULE' &&
            (body.reference === undefined || body.offsetMinutes === undefined)
        )
            throw status(400, 'Bad Request')
        if (body.operation === 'ACTIVATE') {
            const snapshot = await hostSnapshot(roomId)
            const target = snapshot.timeline.find((item) => item.id === id)
            if (target && BOT_ACTIONS.has(target.action)) {
                const [config] = await db
                    .select()
                    .from(botConfigs)
                    .where(eq(botConfigs.groupId, info.groupId))
                    .limit(1)
                if (!config)
                    throw status(409, 'Discord is not connected for this group')
                if (
                    (target.action === 'BEGIN' &&
                        !config.announcementsEnabled) ||
                    (target.action === 'STAFF_START' && !config.signupsEnabled)
                )
                    throw status(409, 'This bot feature is disabled')
            }
        }
        const raw = await dataRedis.eval<string | null>(
            CHANGE_EVENT,
            [roomKey(roomId)],
            [
                String(Date.now()),
                roomId,
                roomChannel(roomId),
                id,
                body.operation,
                has(permissions, PERM.START_ROOM) ? 'HOST' : 'DISPATCH',
                body.reference ?? '',
                String(body.offsetMinutes ?? 0),
                session.user!.userId,
            ],
        )
        if (!raw || raw === 'NOT_FOUND') throw status(404, 'Not Found')
        if (raw === 'FORBIDDEN') throw status(403, 'Forbidden')
        if (raw === 'CONFLICT')
            throw status(409, 'This event has already been handled')
        return JSON.parse(raw) as HostModel.Snapshot
    }
    static async upload(roomId: string, file: File, session: session) {
        const info = await requireRoom(roomId)
        await assertGroupPermission(session, info.groupId, PERM.START_ROOM)
        const image = await MediaService.upload(
            {
                file,
                groupId: info.groupId,
                ownerType: 'SHIFT',
                ownerId: info.eventId,
            },
            session,
        )
        const previous = await hostSnapshot(roomId)
        return writeRoomNote(
            roomId,
            info.eventId,
            info.occurrence,
            {
                note: previous.note,
                ownerRobloxId: previous.ownerRobloxId,
                imageUrl: image.url,
            },
            true,
        )
    }
    static async note(roomId: string, body: HostModel.Note, session: session) {
        const info = await requireRoom(roomId)
        await assertGroupPermission(session, info.groupId, PERM.START_ROOM)
        return writeRoomNote(roomId, info.eventId, info.occurrence, body)
    }
}
export async function writeRoomNote(
    roomId: string,
    eventId: string,
    occurrence: string,
    body: HostModel.Note,
    trustedImage = false,
) {
    if (!trustedImage && body.imageUrl && !validImageUrl(body.imageUrl))
        throw status(400, 'Bad Request')
    const raw = await dataRedis.eval<string | null>(
        SET_NOTE,
        [roomKey(roomId), `shiftnote:${eventId}:${Date.parse(occurrence)}`],
        [String(Date.now()), roomId, roomChannel(roomId), JSON.stringify(body)],
    )
    if (!raw) throw status(404, 'Not Found')
    return JSON.parse(raw) as HostModel.Snapshot
}
function validImageUrl(value: string) {
    try {
        const url = new URL(value)
        return (
            url.protocol === 'https:' &&
            ['cdn.discordapp.com', 'media.discordapp.net'].includes(
                url.hostname,
            )
        )
    } catch {
        return false
    }
}
