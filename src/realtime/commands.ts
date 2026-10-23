import { and, eq } from 'drizzle-orm'
import db from '../db'
import { routes } from '../db/schema'
import { dataRedis } from '../utils/redis'
import { roomChannel, roomKey } from '../rooms/service'
import { NOTE_ROUTE } from '../rooms/dispatch/assign'
import { vehicleKey, VEHICLE_TTL_SECONDS } from '../rooms/dispatch/service'
import { buildCommand, isLive, routeCommandValue, type GameCommandType, type QueuedCommand } from './rules'
import { ENQUEUE_COMMAND } from './redisScripts'

export const commandQueueKey = (roomId: string) => `dispatchroom:${roomId}:commands`

/** What the room knows about the server feeding it, read from the room hash. */
export async function roomGame(roomId: string): Promise<{ live: boolean; routes: string[] | null }> {
    const [lastAt, served] = await Promise.all([
        dataRedis.hget(roomKey(roomId), 'gameAt'),
        dataRedis.hget(roomKey(roomId), 'gameRoutes')
    ])
    let parsed: string[] | null = null
    try { parsed = served ? JSON.parse(served) : null } catch { /* An unreadable list is the same as none. */ }
    return { live: isLive(Number(lastAt) || null, Date.now()), routes: Array.isArray(parsed) ? parsed : null }
}

async function enqueue(roomId: string, queued: QueuedCommand) {
    await dataRedis.eval(ENQUEUE_COMMAND,
        [roomKey(roomId), commandQueueKey(roomId), vehicleKey(roomId, String(queued.command.Vehicle))],
        [queued.key, JSON.stringify(queued), String(VEHICLE_TTL_SECONDS), roomChannel(roomId),
            String(queued.command.Vehicle), queued.assignment ? '1' : '0'])
}

/**
 * Turns a route the board just stored into the command the game needs.
 *
 * Only a real route travels. Clearing a vehicle, writing it a note, or a
 * route this server does not offer has no game command that means the same
 * thing — "unassigned" is not "end your shift" — so those stay on the board.
 */
export async function queueRoute(roomId: string, groupId: string, dispatcher: number, vehicleId: string, route: string | null) {
    if (!route || route === NOTE_ROUTE) return false
    const game = await roomGame(roomId)
    if (!game.live) return false
    let name = route
    if (/^[0-9a-f-]{36}$/i.test(route)) {
        const [row] = await db.select({ name: routes.name }).from(routes)
            .where(and(eq(routes.id, route), eq(routes.groupId, groupId))).limit(1)
        if (!row) return false
        name = row.name
    }
    const value = routeCommandValue(name, game.routes)
    const queued = value === null ? null : buildCommand(dispatcher, vehicleId, 'Route', value)
    if (!queued) return false
    await enqueue(roomId, queued)
    return true
}

export async function queueOrder(roomId: string, dispatcher: number, vehicleId: string, type: GameCommandType, value?: number) {
    if (!(await roomGame(roomId)).live) return false
    const queued = buildCommand(dispatcher, vehicleId, type, value)
    if (!queued) return false
    await enqueue(roomId, queued)
    return true
}
