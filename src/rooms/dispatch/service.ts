import { status } from 'elysia'
import { and, eq, inArray } from 'drizzle-orm'
import db from '../../db'
import { routes, users } from '../../db/schema'
import type { VehicleCategory } from '../../db/schema'
import { dataRedis } from '../../utils/redis'
import { broker } from '../../utils/events'
import { globalModel } from '../../utils/globalModel'
import { roomChannel, roomUsersKey, roomVehiclesKey, requireRoom, type RoomInfo } from '../service'
import { Vehicles } from './model'
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

const vehicleKey = (roomId: string, vehicleId: string) => `dispatchroom:${roomId}:vehicles:${vehicleId}`

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

export abstract class DispatchControls {
    static async getAllVehicles(roomId: string, info: RoomInfo): Promise<Vehicles.vehicleList> {
        const ids = await dataRedis.lrange(roomVehiclesKey(roomId), 0, -1)
        if (ids.length === 0) return []

        const pipeline = dataRedis.pipeline()
        for (const id of ids) pipeline.hgetall(vehicleKey(roomId, id))
        const results = await pipeline.exec()

        const decoded = (results ?? [])
            .map(([error, value]) => (error ? null : decode(value as Record<string, string>)))
            .filter((vehicle): vehicle is Omit<Vehicles.vehicle, 'routeName' | 'routeColor'> => vehicle !== null)

        return decorate(info.groupId, decoded)
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
        const stackKey = roomVehiclesKey(roomId)

        const incoming = new Map<string, Vehicles.seedVehicle>()
        for (const vehicle of payload) incoming.set(vehicle.Id.toString(), vehicle)

        const current = await dataRedis.lrange(stackKey, 0, -1)
        const currentSet = new Set(current)

        const removed = current.filter((id) => !incoming.has(id))
        for (const id of removed) {
            await dataRedis.del(vehicleKey(roomId, id))
            await dataRedis.lrem(stackKey, 1, id)
            await broker.publish(roomChannel(roomId), { event: 'DELETE', data: id })
        }

        // A vehicle deleted in game takes its tow with it. Without this the
        // tow truck keeps pointing at an id nothing resolves, and the board
        // shows it towing a blank.
        await DispatchControls.releaseTows(roomId, info, removed)

        const context = await loadSolverContext(
            info.groupId,
            payload.map((vehicle) => vehicle.OwnerId.toString())
        )

        let added = 0

        for (const [id, vehicle] of incoming) {
            if (currentSet.has(id)) {
                // A vehicle already here still gets its list re-checked, so a
                // manager who fixes a misfiled vehicle in settings can put the
                // board right by pressing Import rather than by closing the
                // room. Nothing else about the vehicle is touched.
                const rule = matchRule(vehicle.Name, context)
                const category: VehicleCategory = rule?.category ?? inferCategory(vehicle.Name)
                const held = await dataRedis.hget(vehicleKey(roomId, id), 'category')

                if (held !== category) {
                    await dataRedis.hset(vehicleKey(roomId, id), { category })
                    await broker.publish(roomChannel(roomId), {
                        event: 'UPDATE',
                        data: { id, category }
                    })
                }

                continue
            }

            const rule = matchRule(vehicle.Name, context)
            const category: VehicleCategory = rule?.category ?? inferCategory(vehicle.Name)

            const stored: StoredVehicle = {
                id,
                ownerId: vehicle.OwnerId.toString(),
                name: vehicle.Name,
                depot: vehicle.Depot,
                // Resolved once here rather than on every solve, so the room
                // keeps working even if a depot is renamed mid-shift.
                depotId: resolveDepotId(vehicle.Depot, context) ?? '',
                route: rule?.fixedRoute ?? '',
                category,
                assigned: 'false',
                towing: '',
                note: '',
                location: '',
                status: 'AWAITING'
            }

            await dataRedis.hset(vehicleKey(roomId, id), stored)
            await dataRedis.expire(vehicleKey(roomId, id), VEHICLE_TTL_SECONDS)
            await dataRedis.rpush(stackKey, id)

            added += 1

            const [decorated] = await decorate(info.groupId, [decode(stored as unknown as Record<string, string>)!])
            await broker.publish(roomChannel(roomId), { event: 'ADD', data: decorated })
        }

        await dataRedis.expire(stackKey, VEHICLE_TTL_SECONDS)

        const total = await dataRedis.llen(stackKey)

        return { added, removed: removed.length, total }
    }

    static async modifyVehicle(roomId: string, vehicleId: string, info: RoomInfo, body: Vehicles.modifyBody) {
        const exists = await dataRedis.exists(vehicleKey(roomId, vehicleId))
        if (!exists) throw status(404, 'Not Found' satisfies globalModel.notFound)

        // A tow is the one field on a vehicle that talks about another one, so
        // it is the one field that can contradict the rest of the room. Two
        // trucks claiming the same casualty would leave whichever the board
        // drew last looking correct, so the second claim is refused outright
        // rather than silently taking the tow off the first.
        if (body.towing) {
            if (body.towing === vehicleId) {
                throw status(409, 'a vehicle cannot tow itself' satisfies Vehicles.towProblem)
            }

            const target = await dataRedis.exists(vehicleKey(roomId, body.towing))
            if (!target) {
                throw status(409, 'that vehicle is not in this room' satisfies Vehicles.towProblem)
            }

            const held = (await DispatchControls.getAllVehicles(roomId, info)).some(
                (vehicle) => vehicle.id !== vehicleId && vehicle.towing === body.towing
            )
            if (held) {
                throw status(409, 'that vehicle is already being towed' satisfies Vehicles.towProblem)
            }
        }

        const patch: Record<string, string> = {}
        if (body.route !== undefined) patch.route = body.route ?? ''
        if (body.assigned !== undefined) patch.assigned = body.assigned ? 'true' : 'false'
        if (body.towing !== undefined) patch.towing = body.towing ?? ''
        if (body.note !== undefined) patch.note = body.note
        if (body.location !== undefined) patch.location = body.location
        if (body.status !== undefined) patch.status = body.status
        if (body.category !== undefined) patch.category = body.category

        if (Object.keys(patch).length === 0) return 'Success' as globalModel.genericSuccess

        await dataRedis.hset(vehicleKey(roomId, vehicleId), patch)

        await broker.publish(roomChannel(roomId), {
            event: 'UPDATE',
            data: { id: vehicleId, ...body }
        })

        return 'Success' as globalModel.genericSuccess
    }

    static async deleteVehicle(roomId: string, vehicleId: string, info: RoomInfo) {
        const removed = await dataRedis.lrem(roomVehiclesKey(roomId), 1, vehicleId)
        if (removed === 0) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await dataRedis.del(vehicleKey(roomId, vehicleId))
        await broker.publish(roomChannel(roomId), { event: 'DELETE', data: vehicleId })

        await DispatchControls.releaseTows(roomId, info, [vehicleId])

        return 'Success' as globalModel.genericSuccess
    }

    /** Drops any tow pointing at a vehicle that has left the room. */
    private static async releaseTows(roomId: string, info: RoomInfo, goneIds: string[]) {
        if (goneIds.length === 0) return

        const gone = new Set(goneIds)
        const vehicles = await DispatchControls.getAllVehicles(roomId, info)

        for (const vehicle of vehicles) {
            if (!vehicle.towing || !gone.has(vehicle.towing)) continue

            await dataRedis.hset(vehicleKey(roomId, vehicle.id), { towing: '' })
            await broker.publish(roomChannel(roomId), {
                event: 'UPDATE',
                data: { id: vehicle.id, towing: null }
            })
        }
    }

    /** Runs automatic assignment across the room and broadcasts the result. */
    static async solveRoom(roomId: string, info: RoomInfo, body: Vehicles.solveBody): Promise<Vehicles.solveResponse> {
        const vehicles = await this.getAllVehicles(roomId, info)

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

        for (const assignment of result.assignments) {
            await dataRedis.hset(vehicleKey(roomId, assignment.vehicleId), { route: assignment.route ?? '' })
            await broker.publish(roomChannel(roomId), {
                event: 'UPDATE',
                data: { id: assignment.vehicleId, route: assignment.route }
            })
        }

        return {
            solved: result.assignments.length,
            skipped: result.skipped,
            assignments: result.assignments.map((assignment) => ({
                vehicleId: assignment.vehicleId,
                route: assignment.route
            }))
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
        const vehicles = await this.getAllVehicles(roomId, info)
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

    static async join(roomId: string, userId: string) {
        await dataRedis.hincrby(roomUsersKey(roomId), userId, 1)
        await dataRedis.expire(roomUsersKey(roomId), VEHICLE_TTL_SECONDS)
        await broker.publish(roomChannel(roomId), {
            event: 'PRESENCE',
            data: await DispatchControls.present(roomId)
        })
    }

    static async leave(roomId: string, userId: string) {
        const remaining = await dataRedis.hincrby(roomUsersKey(roomId), userId, -1)
        if (remaining <= 0) await dataRedis.hdel(roomUsersKey(roomId), userId)

        await broker.publish(roomChannel(roomId), {
            event: 'PRESENCE',
            data: await DispatchControls.present(roomId)
        })
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
    static async *stream(roomId: string, userId: string): AsyncGenerator<Vehicles.streamEvent> {
        const info = await requireRoom(roomId)

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

        await DispatchControls.join(roomId, userId)

        const heartbeat = setInterval(() => push({ event: 'HEARTBEAT' }), 15_000)

        try {
            // Open with the full picture so a reconnecting client is correct
            // immediately rather than after the next change. Presence goes out
            // the same way: a client must not have to wait for somebody else
            // to come or go before it knows who is here.
            yield { event: 'SYNC', data: await DispatchControls.getAllVehicles(roomId, info) }
            yield { event: 'PRESENCE', data: await DispatchControls.present(roomId) }

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

                // The room can expire underneath us mid-shift.
                if ((await dataRedis.exists(`room:${roomId}`)) === 0) {
                    yield { event: 'CLOSED' }
                    return
                }
            }
        } finally {
            clearInterval(heartbeat)
            unsubscribe()
            await DispatchControls.leave(roomId, userId).catch(() => undefined)
        }
    }
}
