import { status } from 'elysia'
import { and, eq } from 'drizzle-orm'
import db from '../db'
import { groups, routes } from '../db/schema'
import type { VehicleCategory } from '../db/schema'
import { env } from '../utils/env'
import { dataRedis } from '../utils/redis'
import { rateLimit } from '../utils/ratelimit'
import { timingSafeEqual } from '../utils/crypto'
import { hashToken, type session } from '../utils/sessionVerifier'
import { assertAnyGroupPermission } from '../utils/groupPermission'
import { PERM } from '../utils/permissions'
import { findGroup } from '../groups/service'
import { globalModel } from '../utils/globalModel'
import { groupIndexKey, roomChannel, roomKey, touchRoom, type RoomInfo } from '../rooms/service'
import { recordDrivers } from '../schedule/instances'
import {
    addChanges, commitChanges, fromPairs, loadVehicles, patchChange, removeVehicles, type StoredVehicle
} from '../rooms/dispatch/service'
import { inferCategory, loadSolverContext, matchRule, resolveDepotId } from '../rooms/dispatch/solver'
import type { Vehicles } from '../rooms/dispatch/model'
import { commandQueueKey } from './commands'
import { DRAIN_COMMANDS, REPORT } from './redisScripts'
import { recordAttendance } from './attendance'
import {
    adoptedRoute, COMMANDS_PER_RESPONSE, isLive, shouldAdoptAssignment,
    type GameCommand, type QueuedCommand
} from './rules'
import type { RealtimeModel } from './model'

const groupLookupKey = (robloxGroupId: string) => `gamefeed:group:${robloxGroupId}`
export const feedStatusKey = (groupId: string) => `gamefeed:${groupId}`
const feedVehiclesKey = (groupId: string) => `gamefeed:${groupId}:vehicles`
const vehiclePrefixFor = (roomId: string) => `dispatchroom:${roomId}:vehicles:`

/** Status survives a quiet minute or two, so a host can see when the feed last spoke. */
const STATUS_TTL_SECONDS = 60 * 30
/** The last report, kept just long enough to seed a room opened between two requests. */
const SNAPSHOT_TTL_SECONDS = 120

function authorized(header: string | null): boolean {
    // An unset token closes the feed rather than opening it, like the bot's.
    if (!env.GAME_FEED_TOKEN || !header?.startsWith('Bearer ')) return false
    return timingSafeEqual(hashToken(header.slice(7).trim()), hashToken(env.GAME_FEED_TOKEN))
}

/**
 * The group a server says it belongs to, cached briefly.
 *
 * Every hosted server asks every fifteen seconds, and the answer only changes
 * when a group registers or leaves. A miss is cached too, so a server pointed
 * at an unregistered group does not cost a query each time it is told 404.
 */
async function groupFor(robloxGroupId: string): Promise<string | null> {
    const cached = await dataRedis.get(groupLookupKey(robloxGroupId))
    if (cached) return cached === '-' ? null : cached
    const [row] = await db.select({ id: groups.id }).from(groups).where(eq(groups.robloxId, robloxGroupId)).limit(1)
    await dataRedis.set(groupLookupKey(robloxGroupId), row?.id ?? '-', 'EX', 300)
    return row?.id ?? null
}

function text(value: unknown, max = 120): string {
    return typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' ? String(value) : ''
}

function readStatus(raw: Record<string, string>, queued: number, now = Date.now()): Vehicles.gameStatus {
    const lastAt = Number(raw.lastAt) || null
    let served: unknown = null
    try { served = raw.routes ? JSON.parse(raw.routes) : null } catch { /* treated as unknown */ }
    return {
        live: isLive(lastAt, now),
        lastAt,
        runtime: raw.runtime ? Number(raw.runtime) : null,
        gameTime: raw.gameTime ? Number(raw.gameTime) : null,
        players: Number(raw.players) || 0,
        routes: Array.isArray(served) ? served.map(String) : null,
        queued
    }
}

/** What a room's dispatchers see about the server feeding it. */
export async function roomGameStatus(roomId: string): Promise<Vehicles.gameStatus | null> {
    const [raw, queued] = await Promise.all([
        dataRedis.hgetall(roomKey(roomId)),
        dataRedis.llen(commandQueueKey(roomId))
    ])
    if (!raw.gameAt) return null
    return readStatus({ lastAt: raw.gameAt, runtime: raw.gameRuntime, gameTime: raw.gameTime, players: raw.gamePlayers, routes: raw.gameRoutes }, Number(queued))
}

/**
 * The group's routes, as a report matches the game's assignments against
 * them. Held for a minute per process: every server reports every fifteen
 * seconds and the list changes when a manager edits it, so a new route is
 * recognized within a minute instead of costing a query on every report.
 */
const routeCache = new Map<string, { at: number; rows: Array<{ id: string; name: string; color: string }> }>()
async function liveRoutes(groupId: string) {
    const cached = routeCache.get(groupId)
    if (cached && Date.now() - cached.at < 60_000) return cached.rows
    const rows = await db.select({ id: routes.id, name: routes.name, color: routes.color }).from(routes)
        .where(and(eq(routes.groupId, groupId), eq(routes.archived, false)))
    if (routeCache.size >= 256) routeCache.delete(routeCache.keys().next().value!)
    routeCache.set(groupId, { at: Date.now(), rows })
    return rows
}

/**
 * Brings a room's board into line with one report from the game.
 *
 * The same reconciliation a pasted import does — vehicles the game no longer
 * reports leave, new ones arrive classified — plus the fields only the game
 * can know. Vehicles keep their dispatch state across reports; a vehicle
 * number that reappears under a different owner is a different vehicle that
 * happens to share a number, so it is replaced rather than inheriting
 * somebody else's route.
 */
export async function syncRoom(roomId: string, info: RoomInfo, payload: RealtimeModel.Vehicle[]) {
    const [current, groupRoutes] = await Promise.all([loadVehicles(roomId), liveRoutes(info.groupId)])
    const incoming = new Map<string, RealtimeModel.Vehicle>()
    for (const vehicle of payload) {
        const id = text(vehicle.Id, 32)
        if (/^[0-9A-Za-z_-]{1,32}$/.test(id)) incoming.set(id, vehicle)
    }
    const held = new Map(current.vehicles.map((vehicle) => [vehicle.id, vehicle]))
    const replaced = current.vehicles.filter((vehicle) => {
        const next = incoming.get(vehicle.id)
        return next && text(next.OwnerId, 32) !== vehicle.ownerId
    }).map((vehicle) => vehicle.id)
    const gone = [...current.ids.filter((id) => !incoming.has(id)), ...replaced]
    if (gone.length) await removeVehicles(roomId, gone)
    for (const id of replaced) held.delete(id)

    const changes: Awaited<ReturnType<typeof addChanges>> = []
    const fresh: Array<[string, RealtimeModel.Vehicle]> = []
    for (const [id, vehicle] of incoming) {
        const before = held.get(id)
        if (!before) { fresh.push([id, vehicle]); continue }
        const gameRoute = text(vehicle.Route, 64)
        const gameAssigned = text(vehicle.AssignedRoute, 64)
        const tablet = vehicle.TabletEquipped === true
        const patch: Record<string, string> = {}
        const data: Vehicles.streamEvent & { event: 'UPDATE' } = { event: 'UPDATE', data: { id } }
        if (before.gameRoute === null) patch.live = 'true'
        if (before.gameRoute !== gameRoute) { patch.gameRoute = gameRoute; data.data.gameRoute = gameRoute }
        if (before.gameAssigned !== gameAssigned) { patch.gameAssigned = gameAssigned; data.data.gameAssigned = gameAssigned }
        if (before.tablet !== tablet) { patch.tablet = String(tablet); data.data.tablet = tablet }
        // A command handed over last time has had its answer: this report.
        if (before.command === 'SENT') { patch.command = ''; data.data.command = null }
        if (shouldAdoptAssignment(before.gameAssigned ?? '', gameAssigned, before.command ?? '')) {
            const next = adoptedRoute(groupRoutes, gameAssigned)
            if (next !== (before.route ?? '')) {
                const known = groupRoutes.find((route) => route.id === next)
                patch.route = next
                Object.assign(data.data, { route: next || null, routeName: known?.name ?? (next || null), routeColor: known?.color ?? null })
            }
        }
        if (Object.keys(patch).length) changes.push(patchChange(roomId, id, patch, data))
    }

    if (fresh.length) {
        const context = await loadSolverContext(info.groupId, fresh.map(([, vehicle]) => text(vehicle.OwnerId, 32)))
        const seeds: StoredVehicle[] = fresh.map(([id, vehicle]) => {
            const name = text(vehicle.Name)
            const depot = text(vehicle.Depot)
            const rule = matchRule(name, context)
            const assigned = text(vehicle.AssignedRoute, 64)
            return {
                id, ownerId: text(vehicle.OwnerId, 32) || '0', name, depot,
                depotId: resolveDepotId(depot, context) ?? '',
                route: assigned ? adoptedRoute(groupRoutes, assigned) : rule?.fixedRoute ?? '',
                category: rule?.category ?? inferCategory(name) as VehicleCategory,
                assigned: 'false', towing: '', note: '', location: '', status: 'AWAITING',
                gameRoute: text(vehicle.Route, 64), gameAssigned: assigned,
                tablet: String(vehicle.TabletEquipped === true), command: '', live: 'true'
            }
        })
        changes.push(...await addChanges(roomId, info.groupId, seeds))
        const owners = [...new Set(seeds.map((seed) => seed.ownerId))].filter((owner) => owner !== '0')
        if (info.eventId && info.occurrence && owners.length) {
            await recordDrivers(info.eventId, new Date(info.occurrence), owners.map((owner) => ({ robloxId: owner, name: owner })))
                .catch((error) => console.warn('[realtime] driver log failed', error instanceof Error ? error.message : 'unknown'))
        }
    }
    if (changes.length) await commitChanges(roomId, changes, true)
}

/** Hands the game what one response may carry, oldest first. */
async function drain(roomId: string): Promise<{ commands: GameCommand[]; queued: number }> {
    const [taken, queued] = (await dataRedis.eval<[string[], number] | null>(DRAIN_COMMANDS, [roomKey(roomId), commandQueueKey(roomId)],
        [vehiclePrefixFor(roomId), roomChannel(roomId), String(COMMANDS_PER_RESPONSE)])) ?? [[], 0]
    const commands = (taken ?? []).flatMap((raw) => {
        try { return [(JSON.parse(raw) as QueuedCommand).command] } catch { return [] }
    })
    return { commands, queued: Number(queued) || 0 }
}

export abstract class GameFeed {
    /**
     * One report from a hosted server, answered with the commands waiting for it.
     *
     * Always 200 for a group TrPTools knows, room or no room: the game treats
     * anything else as a reason to back off or stop, and a server that starts
     * before the shift has to still be talking when the host opens the room.
     * 404 is kept for "this group is not on TrPTools", which the game shows
     * its host as "not set up yet".
     */
    static async receive(robloxGroupId: string, authorization: string | null, body: RealtimeModel.Report): Promise<GameCommand[]> {
        if (!authorized(authorization)) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
        const groupId = /^[0-9]{1,20}$/.test(robloxGroupId) ? await groupFor(robloxGroupId) : null
        if (!groupId) throw status(404, 'Not Found' satisfies globalModel.notFound)
        // Several servers can share a group; one every five seconds is three
        // times what the game sends from one.
        await rateLimit('realtime:game', groupId, 36, 60)

        const now = Date.now()
        const vehicles = body.Vehicles ?? []
        const people = body.Users ?? []
        const server = body.ServerData ?? {}
        const serverRoutes = Array.isArray(server.routes) ? JSON.stringify(server.routes.map((route) => text(route, 64))) : ''
        const fields: Record<string, string> = {
            lastAt: String(now), players: String(people.length),
            runtime: Number.isFinite(server.runtime) ? String(Math.max(0, Math.floor(server.runtime!))) : '',
            gameTime: Number.isFinite(server.gametime) ? String(Math.min(1439, Math.max(0, Math.floor(server.gametime!)))) : '',
            routes: serverRoutes
        }
        const roomFields = {
            gameAt: fields.lastAt!, gamePlayers: fields.players!, gameRuntime: fields.runtime!,
            gameTime: fields.gameTime!, gameRoutes: serverRoutes
        }
        const opened = await dataRedis.eval<[string, string[]] | null>(REPORT,
            [feedStatusKey(groupId), feedVehiclesKey(groupId), groupIndexKey(groupId)],
            [String(now), String(STATUS_TTL_SECONDS), String(SNAPSHOT_TTL_SECONDS), JSON.stringify(vehicles),
                JSON.stringify(fields), JSON.stringify(roomFields)])
        const roomId = opened ? opened[0] : null
        const info = opened ? fromPairs(opened[1]) as unknown as RoomInfo : null

        await recordAttendance(groupId, info, people, now)
            .catch((error) => console.warn('[realtime] attendance failed', error instanceof Error ? error.message : 'unknown'))
        if (!roomId || !info?.groupId) return []

        await syncRoom(roomId, info, vehicles)
        const { commands, queued } = await drain(roomId)
        // Everything the GAME frame says is already in hand: the fields this
        // report wrote and what the drain left queued.
        const game = readStatus({ lastAt: fields.lastAt!, runtime: fields.runtime!, gameTime: fields.gameTime!,
            players: fields.players!, routes: serverRoutes }, queued, now)
        await dataRedis.publish(roomChannel(roomId), JSON.stringify({ event: 'GAME', data: game } satisfies Vehicles.streamEvent))
        return commands
    }

    /**
     * Seeds a room that has just opened from the last report, so the board
     * is full the moment it appears rather than fifteen seconds later.
     */
    static async seed(roomId: string, info: RoomInfo) {
        const [raw, status] = await Promise.all([
            dataRedis.get(feedVehiclesKey(info.groupId)),
            dataRedis.hgetall(feedStatusKey(info.groupId))
        ])
        if (!raw || !isLive(Number(status.lastAt) || null, Date.now())) return
        let vehicles: RealtimeModel.Vehicle[]
        try { vehicles = JSON.parse(raw) } catch { return }
        await dataRedis.hset(roomKey(roomId), {
            gameAt: status.lastAt ?? '', gamePlayers: status.players ?? '0', gameRuntime: status.runtime ?? '',
            gameTime: status.gameTime ?? '', gameRoutes: status.routes ?? ''
        })
        await syncRoom(roomId, info, vehicles)
    }

    /** The group's feed as hosts see it, room or no room. */
    static async status(groupIdOrSlug: string, session: session): Promise<Vehicles.gameStatus> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)
        await assertAnyGroupPermission(session, group.id, [PERM.START_ROOM, PERM.DISPATCH])
        const roomId = await dataRedis.get(groupIndexKey(group.id))
        const queued = roomId ? Number(await dataRedis.llen(commandQueueKey(roomId))) : 0
        return readStatus(await dataRedis.hgetall(feedStatusKey(group.id)), queued)
    }
}
