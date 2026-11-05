import { status } from 'elysia'
import { inArray } from 'drizzle-orm'
import db from '../db'
import { groups, routes } from '../db/schema'
import { groupName } from '../groups/service'
import { dataRedis } from '../utils/redis'
import type { session } from '../utils/sessionVerifier'
import { NOTE_ROUTE } from '../rooms/dispatch/assign'
import { DRIVER_VIEW } from './redisScripts'
import { instructionsFor, type DriverRow } from './rules'
import type { DriverModel } from './model'

export const driverIndexKey = (robloxId: string) => `driverindex:${robloxId}`

const UUID = /^[0-9a-f-]{36}$/i

export abstract class Driver {
    /**
     * What every open dispatch room is telling the caller's own vehicles.
     *
     * One Redis call finds them through the driver index the board writes on
     * import, rather than walking every open room, and drops entries for
     * vehicles that have since left. Postgres is asked only for the names
     * of the groups and routes involved, and only when there is a vehicle.
     */
    static async mine(session: session): Promise<DriverModel.response> {
        if (!session.user) throw status(401, 'Unauthorized')

        const owner = String(session.user.robloxId)
        const raw = await dataRedis.eval<string>(DRIVER_VIEW, [driverIndexKey(owner)], [owner])
        const rows = (raw ? JSON.parse(raw) : []) as DriverRow[]
        if (rows.length === 0) return { stateIndex: '', vehicles: [] }

        const groupIds = [...new Set(rows.map((row) => row.room.groupId).filter((id) => UUID.test(id)))]
        const routeIds = [...new Set(rows.map((row) => row.vehicle.route).filter((id): id is string => Boolean(id) && UUID.test(id!)))]
        const [groupRows, routeRows] = await Promise.all([
            groupIds.length
                ? db.select({ id: groups.id, name: groups.name, cachedName: groups.cachedName, robloxId: groups.robloxId })
                    .from(groups).where(inArray(groups.id, groupIds))
                : [],
            routeIds.length
                ? db.select({ id: routes.id, name: routes.name, color: routes.color }).from(routes).where(inArray(routes.id, routeIds))
                : []
        ])

        const names = new Map(groupRows.map((row) => [row.id, groupName(row)]))
        const routeById = new Map(routeRows.map((row) => [row.id, row]))
        const vehicles = rows.map((row) => instructionsFor(row, {
            groupName: names.get(row.room.groupId) ?? '',
            route: (id) => routeById.get(id) ?? null,
            noteRoute: NOTE_ROUTE
        }))

        return {
            stateIndex: vehicles.map((vehicle) => `${vehicle.roomId}/${vehicle.vehicle.id}@${vehicle.stateIndex}`).sort().join(','),
            vehicles
        }
    }
}
