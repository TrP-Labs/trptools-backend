import { status } from 'elysia'
import { and, eq, inArray } from 'drizzle-orm'
import db from '../../db'
import { routes, users } from '../../db/schema'
import type { VehicleCategory } from '../../db/schema'
import { dataRedis } from '../../utils/redis'
import { broker } from '../../utils/events'
import { globalModel } from '../../utils/globalModel'
import { roomChannel, roomUsersKey, roomVehiclesKey, roomKey, requireRoom, type RoomInfo } from '../service'
import { Vehicles } from './model'
import { assertResults, runBatches, type RedisTask } from './batch'
import { ADD_VEHICLE, PATCH_VEHICLE, MODIFY_VEHICLE, DELETE_VEHICLES, CHANGE_PRESENCE } from './redisScripts'
import {
    inferCategory,
    loadRoutePreferences,
    loadSolverContext,
    matchRule,
    resolveDepotId,
    solve,
    type SolverVehicle
} from './solver'

const VEHICLE_TTL_SECONDS = 60 * 60 * 8

const vehiclePrefix = (roomId: string) => `dispatchroom:${roomId}:vehicles:`
const vehicleKey = (roomId: string, vehicleId: string) => `${vehiclePrefix(roomId)}${vehicleId}`

type StoredVehicle = {
    id: string
    ownerId: string
    name: string
    depot: string
    depotId: string
    route: string
    category: string
    assigned: string
    /** The id of the vehicle this one tows, or empty. */
    towing: string
    note: string
    location: string
    status: string
}

const SERVICE_STATUSES: Vehicles.serviceStatus[] = ['AWAITING', 'ENROUTE', 'ON_SCENE', 'RETURNING']

function decode(raw: Record<string, string>): Omit<Vehicles.vehicle, 'routeName' | 'routeColor'> | null {
    if (!raw || !raw.id) return null

    return {
        id: raw.id,
        ownerId: raw.ownerId ?? '0',
        name: raw.name ?? 'Unknown',
        depot: raw.depot ?? '',
        depotId: raw.depotId ? raw.depotId : null,
        route: raw.route === '' || raw.route === undefined ? null : raw.route,
        category: (raw.category as Vehicles.category) ?? 'OTHER',
        assigned: raw.assigned === 'true',
        // Rooms written by an older build stored a bare boolean here, which
        // says a vehicle is towing but not what. Nothing can be drawn from
        // that, so it reads as not towing rather than as a dangling id.
        towing: raw.towing && raw.towing !== 'true' && raw.towing !== 'false' ? raw.towing : null,
        note: raw.note ?? '',
        location: raw.location ?? '',
        status: SERVICE_STATUSES.includes(raw.status as Vehicles.serviceStatus)
            ? (raw.status as Vehicles.serviceStatus)
            : 'AWAITING'
    }
}

/**
 * Attaches display data for assigned routes.
 *
 * A vehicle's `route` is either a route id or a free literal such as "SV", so
 * only the ids get resolved and anything else is shown as typed.
 */
async function decorate(
    groupId: string,
    vehicles: Array<Omit<Vehicles.vehicle, 'routeName' | 'routeColor'>>
): Promise<Vehicles.vehicleList> {
    const ids = [
        ...new Set(
            vehicles
                .map((vehicle) => vehicle.route)
                .filter((route): route is string => Boolean(route) && /^[0-9a-f-]{36}$/i.test(route!))
        )
    ]

    const lookup = new Map<string, { name: string; color: string }>()

    if (ids.length > 0) {
        const rows = await db
            .select({ id: routes.id, name: routes.name, color: routes.color })
            .from(routes)
            .where(and(eq(routes.groupId, groupId), inArray(routes.id, ids)))

        for (const row of rows) lookup.set(row.id, { name: row.name, color: row.color })
    }

    return vehicles.map((vehicle) => {
        const resolved = vehicle.route ? lookup.get(vehicle.route) : undefined
        return {
            ...vehicle,
            routeName: resolved?.name ?? (vehicle.route && !lookup.has(vehicle.route) ? vehicle.route : null),
            routeColor: resolved?.color ?? null
        }
    })
}

type RawVehicle = Omit<Vehicles.vehicle, 'routeName' | 'routeColor'>
type Change = { task: RedisTask; event: Vehicles.streamEvent }

async function loadVehicles(roomId: string): Promise<{ ids: string[]; vehicles: RawVehicle[] }> {
    const ids = await dataRedis.lrange(roomVehiclesKey(roomId), 0, -1)
    const results = await runBatches(dataRedis, ids.map((id) => (pipeline) => pipeline.hgetall(vehicleKey(roomId, id))))
    assertResults(results)
    const vehicles = results.map(([, value]) => decode(value as Record<string, string>))
        .filter((vehicle): vehicle is RawVehicle => vehicle !== null)
    return { ids, vehicles }
}

async function publishEvents(roomId: string, events: Vehicles.streamEvent[]) {
    const results = await runBatches(dataRedis, events.map((event) => (pipeline) =>
        pipeline.publish(roomChannel(roomId), JSON.stringify(event))))
    assertResults(results)
}

async function commitChanges(roomId: string, changes: Change[], refreshList = false) {
    const tasks = changes.map((change) => change.task)
    if (refreshList) tasks.push((pipeline) => pipeline.expire(roomVehiclesKey(roomId), VEHICLE_TTL_SECONDS))
    const results = await runBatches(dataRedis, tasks)
    const events = changes.flatMap((change, index) => {
        const [error, value] = results[index]!
        return !error && value === 1 ? [change.event] : []
    })
    // Pipelines can partially succeed. Publish those writes before surfacing
    // an error, so the other dispatchers still see what Redis actually kept.
    await publishEvents(roomId, events)
    assertResults(results)
    if (results.some(([, value]) => value === -1)) throw status(404, 'Not Found' satisfies globalModel.notFound)
    return events
}

function patchChange(roomId: string, id: string, patch: Record<string, string>, event: Vehicles.streamEvent): Change {
    return {
        task: (pipeline) => pipeline.eval(PATCH_VEHICLE, [roomKey(roomId), vehicleKey(roomId, id)], Object.entries(patch).flat()),
        event
    }
}

export abstract class DispatchControls {
    static async getAllVehicles(roomId: string, info: RoomInfo): Promise<Vehicles.vehicleList> {
        const { vehicles } = await loadVehicles(roomId)
        return decorate(info.groupId, vehicles)
    }

    /**
     * Reconciles the room against a fresh vehicle list from the game.
     *
     * Vehicles missing from the new list have been deleted in game and are
     * dropped; vehicles already present keep their dispatch state so an import
     * never wipes assignments mid-shift.
     */
    static async importVehicles(
        roomId: string,
        info: RoomInfo,
        payload: Vehicles.importBody
    ): Promise<Vehicles.importResponse> {
        const incoming = new Map<string, Vehicles.seedVehicle>()
        for (const vehicle of payload) incoming.set(vehicle.Id.toString(), vehicle)

        const [current, context] = await Promise.all([
            loadVehicles(roomId),
            loadSolverContext(info.groupId, payload.map((vehicle) => vehicle.OwnerId.toString()))
        ])
        const byId = new Map(current.vehicles.map((vehicle) => [vehicle.id, vehicle]))
        const gone = current.ids.filter((id) => !incoming.has(id))
        const removed = gone.length ? await this.removeVehicles(roomId, gone) : 0
        const changes: Change[] = []
        const seeds: StoredVehicle[] = []

        for (const [id, vehicle] of incoming) {
            const rule = matchRule(vehicle.Name, context)
            const category: VehicleCategory = rule?.category ?? inferCategory(vehicle.Name)
            const held = byId.get(id)
            if (held) {
                if (held.category !== category) changes.push(patchChange(roomId, id, { category }, {
                    event: 'UPDATE', data: { id, category }
                }))
                continue
            }
            seeds.push({
                id, ownerId: vehicle.OwnerId.toString(), name: vehicle.Name, depot: vehicle.Depot,
                depotId: resolveDepotId(vehicle.Depot, context) ?? '', route: rule?.fixedRoute ?? '',
                category, assigned: 'false', towing: '', note: '', location: '', status: 'AWAITING'
            })
        }

        const decorated = await decorate(info.groupId, seeds.map((seed) => decode(seed)!))
        seeds.forEach((seed, index) => changes.push({
            task: (pipeline) => pipeline.eval(ADD_VEHICLE,
                [roomKey(roomId), vehicleKey(roomId, seed.id), roomVehiclesKey(roomId)],
                [String(VEHICLE_TTL_SECONDS), seed.id, ...Object.entries(seed).flat()]),
            event: { event: 'ADD', data: decorated[index]! }
        }))
        const events = await commitChanges(roomId, changes, true)
        const total = await dataRedis.llen(roomVehiclesKey(roomId))
        return { added: events.filter((event) => event.event === 'ADD').length, removed, total }
    }

    static async modifyVehicle(roomId: string, vehicleId: string, _info: RoomInfo, body: Vehicles.modifyBody) {
        const patch: Record<string, string> = {}
        if (body.route !== undefined) patch.route = body.route ?? ''
        if (body.assigned !== undefined) patch.assigned = body.assigned ? 'true' : 'false'
        if (body.towing !== undefined) patch.towing = body.towing ?? ''
        if (body.note !== undefined) patch.note = body.note
        if (body.location !== undefined) patch.location = body.location
        if (body.status !== undefined) patch.status = body.status
        if (body.category !== undefined) patch.category = body.category

        const result = await dataRedis.eval<number>(MODIFY_VEHICLE,
            [roomKey(roomId), vehicleKey(roomId, vehicleId), roomVehiclesKey(roomId)],
            [vehicleId, vehiclePrefix(roomId), JSON.stringify(patch), roomChannel(roomId),
                JSON.stringify({ event: 'UPDATE', data: { id: vehicleId, ...body } })])
        if (result === -1) throw status(404, 'Not Found' satisfies globalModel.notFound)
        if (result === -2) throw status(409, 'a vehicle cannot tow itself' satisfies Vehicles.towProblem)
        if (result === -3) throw status(409, 'that vehicle is not in this room' satisfies Vehicles.towProblem)
        if (result === -4) throw status(409, 'that vehicle is already being towed' satisfies Vehicles.towProblem)
        return 'Success' as globalModel.genericSuccess
    }

    private static removeVehicles(roomId: string, ids: string[]) {
        return dataRedis.eval<number>(DELETE_VEHICLES, [roomKey(roomId), roomVehiclesKey(roomId)],
            [vehiclePrefix(roomId), JSON.stringify(ids), roomChannel(roomId)])
    }

    static async deleteVehicle(roomId: string, vehicleId: string, _info: RoomInfo) {
        const removed = await this.removeVehicles(roomId, [vehicleId])
        if (!removed) throw status(404, 'Not Found' satisfies globalModel.notFound)
        return 'Success' as globalModel.genericSuccess
    }

    /** Runs automatic assignment across the room and broadcasts the result. */
    static async solveRoom(roomId: string, info: RoomInfo, body: Vehicles.solveBody): Promise<Vehicles.solveResponse> {
        const { vehicles } = await loadVehicles(roomId)

        const context = await loadSolverContext(
            info.groupId,
            vehicles.map((vehicle) => vehicle.ownerId)
        )

        // The whole room goes to the solver even when only one vehicle is
        // being placed: `only` decides what may be *moved*, while everything
        // else still counts towards the spread it is being placed into.
        const solverVehicles: SolverVehicle[] = vehicles.map((vehicle) => ({
            id: vehicle.id,
            ownerId: vehicle.ownerId,
            name: vehicle.name,
            depot: vehicle.depot,
            // Rooms opened before depots were resolvable, and rows written by
            // an older build, still carry only the spawn name.
            depotId: vehicle.depotId ?? resolveDepotId(vehicle.depot, context),
            route: vehicle.route,
            category: vehicle.category as VehicleCategory
        }))

        const result = solve(solverVehicles, context, {
            includeAssigned: body.includeAssigned,
            only: body.vehicleIds?.length ? body.vehicleIds : undefined
        })

        const events = await commitChanges(roomId, result.assignments.map((assignment) =>
            patchChange(roomId, assignment.vehicleId, { route: assignment.route ?? '' }, {
                event: 'UPDATE', data: { id: assignment.vehicleId, route: assignment.route }
            })))
        const written = new Set(events.flatMap((event) => event.event === 'UPDATE' ? [event.data.id] : []))
        const assignments = result.assignments.filter((assignment) => written.has(assignment.vehicleId))
        return {
            solved: assignments.length,
            skipped: result.skipped,
            assignments: assignments.map((assignment) => ({ vehicleId: assignment.vehicleId, route: assignment.route }))
        }
    }

    /**
     * The route preferences of everybody with a vehicle in the room.
     *
     * The board paints these onto the route dropdown, so a dispatcher choosing
     * by hand can see what the solver would have taken into account — a
     * driver's favourites in green, the routes they would rather avoid in
     * amber. Restricted to the owners actually present, so the response is
     * about this room and not about the group's whole membership.
     */
    static async ownerPreferences(roomId: string, info: RoomInfo): Promise<Vehicles.ownerPreferenceList> {
        const { vehicles } = await loadVehicles(roomId)
        const owners = [...new Set(vehicles.map((vehicle) => vehicle.ownerId))]
        if (owners.length === 0) return []

        const groupRoutes = await db
            .select({ id: routes.id, name: routes.name, builtIn: routes.builtIn })
            .from(routes)
            .where(and(eq(routes.groupId, info.groupId), eq(routes.archived, false)))

        const preferences = await loadRoutePreferences(groupRoutes, owners)

        return [...preferences].map(([robloxId, entry]) => ({
            robloxId,
            favorite: [...entry.favourite],
            disliked: [...entry.disliked]
        }))
    }

    // ------------------------------------------------------------- presence

    /**
     * Who is in the room.
     *
     * Presence counts *streams*, not people: a hash of user id to open
     * connection count. A plain set got this wrong on every reconnect, because
     * the dropped stream's cleanup ran after the replacement had already
     * joined and removed the user outright — leaving the badge reading zero
     * for someone who was plainly there.
     */
    static async present(roomId: string): Promise<string[]> {
        const counts = await dataRedis.hgetall(roomUsersKey(roomId))
        return Object.entries(counts)
            .filter(([, value]) => Number(value) > 0)
            .map(([userId]) => userId)
    }

    static async join(roomId: string, userId: string): Promise<string[]> {
        return dataRedis.eval<string[]>(CHANGE_PRESENCE, [roomKey(roomId), roomUsersKey(roomId)],
            [userId, '1', String(VEHICLE_TTL_SECONDS), roomChannel(roomId)])
    }

    static async leave(roomId: string, userId: string): Promise<string[]> {
        return dataRedis.eval<string[]>(CHANGE_PRESENCE, [roomKey(roomId), roomUsersKey(roomId)],
            [userId, '-1', String(VEHICLE_TTL_SECONDS), roomChannel(roomId)])
    }

    /** The same list, resolved to profiles for the room's presence dialog. */
    static async presence(roomId: string, info: RoomInfo): Promise<Vehicles.presenceList> {
        const userIds = await DispatchControls.present(roomId)
        if (userIds.length === 0) return []

        const rows = await db
            .select({
                userId: users.id,
                robloxId: users.robloxId,
                username: users.cachedUsername,
                displayName: users.cachedDisplayName,
                avatar: users.cachedAvatar
            })
            .from(users)
            .where(inArray(users.id, userIds))

        return rows.map((row) => ({ ...row, host: row.userId === info.creatorId }))
    }

    /**
     * The realtime stream.
     *
     * A queue sits between Redis pub/sub and the HTTP response so a slow
     * client cannot block the broker, and it is bounded so a stalled reader
     * gets dropped instead of growing memory without limit.
     */
    static async *stream(roomId: string, userId: string, room?: RoomInfo): AsyncGenerator<Vehicles.streamEvent> {
        const info = room ?? await requireRoom(roomId)

        const queue: Vehicles.streamEvent[] = []
        let notify: (() => void) | null = null
        let closed = false

        const push = (event: Vehicles.streamEvent) => {
            if (queue.length > 500) {
                closed = true
            } else {
                queue.push(event)
            }
            notify?.()
        }

        const unsubscribe = await broker.subscribe(roomChannel(roomId), (payload) => {
            try {
                push(JSON.parse(payload) as Vehicles.streamEvent)
            } catch {
                // Ignore malformed frames rather than tearing down the stream.
            }
        })

        let joined = false
        let heartbeat: ReturnType<typeof setInterval> | undefined
        let checking = false
        try {
            // Subscribe before loading the snapshot so changes in flight are
            // queued. Joining and reading can share their network wait.
            const [presenceResult, vehiclesResult] = await Promise.allSettled([
                DispatchControls.join(roomId, userId).then((present) => {
                    joined = true
                    return present
                }),
                DispatchControls.getAllVehicles(roomId, info)
            ])
            if (presenceResult.status === 'rejected') throw presenceResult.reason
            if (vehiclesResult.status === 'rejected') throw vehiclesResult.reason
            const presence = presenceResult.value
            const vehicles = vehiclesResult.value
            heartbeat = setInterval(() => {
                push({ event: 'HEARTBEAT' })
                if (checking || closed) return
                checking = true
                void dataRedis.exists(roomKey(roomId)).then((exists) => {
                    if (!exists) push({ event: 'CLOSED' })
                }).catch(() => undefined).finally(() => { checking = false })
            }, 15_000)
            yield { event: 'SYNC', data: vehicles }
            yield { event: 'PRESENCE', data: presence }

            while (!closed) {
                if (queue.length === 0) {
                    await new Promise<void>((resolve) => {
                        notify = () => {
                            notify = null
                            resolve()
                        }
                    })
                }

                while (queue.length > 0) {
                    const event = queue.shift()!
                    yield event
                    if (event.event === 'CLOSED') return
                }
            }
        } finally {
            clearInterval(heartbeat)
            unsubscribe()
            if (joined) await DispatchControls.leave(roomId, userId).catch(() => undefined)
        }
    }
}
