import { eq } from 'drizzle-orm'
import db from '../db'
import { globalRoutePreferences, users, type VehicleCategory } from '../db/schema'
import { BUILT_IN_ROUTES, DEFAULT_DEPOTS, DEFAULT_VEHICLE_TYPES } from '../groups/defaults'
import {
    depotKey,
    inferCategory,
    matchRule,
    resolveDepotId,
    solve,
    type SolverContext,
    type SolverVehicle
} from '../rooms/dispatch/assign'
import type { session } from '../utils/sessionVerifier'
import { ToolsModel } from './model'

/**
 * Dispatch for one person, with no group behind it.
 *
 * The board on the dashboard is the real thing: a room several dispatchers
 * share, a group's own routes and depots, live updates. This is the same
 * board with none of that — somebody trying TrPTools out, or running a shift
 * on their own, gets the game's built-in routes and depots and nothing to set
 * up first.
 *
 * There is deliberately **no state here**. The vehicles live in the browser;
 * the server classifies a pasted list and answers questions about it. That is
 * what makes it a single-user tool rather than a room with one person in it,
 * and it means no dispatch state is stored for people who never registered a
 * group.
 *
 * The routes and depots are the seeds every new group is given
 * (`groups/defaults.ts`), so what somebody learns here is what they will find
 * on the dashboard afterwards.
 */

/** Stable ids for rows that do not exist. Route ids are UUIDs elsewhere. */
const routeId = (name: string) => `builtin-route-${name}`
const depotId = (number: number) => `builtin-depot-${number}`

function context(preferences: SolverContext['preferences']): SolverContext {
    const depotsByKey = new Map<string, string>()
    for (const depot of DEFAULT_DEPOTS) {
        for (const spelling of [depot.name, depot.number.toString(), ...depot.aliases]) {
            const key = depotKey(spelling)
            if (key) depotsByKey.set(key, depotId(depot.number))
        }
    }

    const rules = DEFAULT_VEHICLE_TYPES.map((type) => ({
        pattern: type.name,
        category: type.category,
        fixedRoute: null
    }))

    const typesByName = new Map<string, (typeof rules)[number]>()
    for (const rule of rules) {
        const key = rule.pattern.trim().toLowerCase()
        if (!typesByName.has(key)) typesByName.set(key, rule)
    }

    return {
        routes: BUILT_IN_ROUTES.map((route) => ({
            id: routeId(route.name),
            name: route.name,
            autoAssign: true,
            // An even split. A share is a group's decision about its own
            // service, and there is no group here to have made one.
            targetShare: 20,
            depotIds: new Set(route.depots.map(depotId)),
            servesAllDepots: false
        })),
        depotsByKey,
        rules,
        typesByName,
        preferences
    }
}

/**
 * The signed-in person's own marks, against these routes.
 *
 * Only the built-in routes exist here and those are marked globally, so the
 * answer somebody gave on a group's page is the answer that applies — which is
 * the whole reason the marks are held by name.
 *
 * Only *their* marks, and only against *their* vehicles: a personal board is
 * not a reason to hand out what other drivers have asked for, and the room
 * endpoint that does publish them is gated on dispatching for that group.
 */
async function ownPreferences(session: session): Promise<SolverContext['preferences']> {
    const preferences: SolverContext['preferences'] = new Map()
    if (!session.user) return preferences

    const [account] = await db
        .select({ robloxId: users.robloxId })
        .from(users)
        .where(eq(users.id, session.user.userId))
        .limit(1)

    if (!account) return preferences

    const rows = await db
        .select({
            routeName: globalRoutePreferences.routeName,
            preference: globalRoutePreferences.preference
        })
        .from(globalRoutePreferences)
        .where(eq(globalRoutePreferences.userId, session.user.userId))

    const entry = { favourite: new Set<string>(), disliked: new Set<string>() }
    const names = new Set<string>(BUILT_IN_ROUTES.map((route) => route.name))

    for (const row of rows) {
        if (!names.has(row.routeName)) continue
        if (row.preference === 'FAVORITE') entry.favourite.add(routeId(row.routeName))
        else entry.disliked.add(routeId(row.routeName))
    }

    if (entry.favourite.size > 0 || entry.disliked.size > 0) {
        preferences.set(account.robloxId.toString(), entry)
    }

    return preferences
}

export abstract class PersonalDispatch {
    /** The routes and depots this board runs, drawn as the game ships them. */
    static setup(): ToolsModel.dispatchSetup {
        return {
            routes: BUILT_IN_ROUTES.map((route, index) => ({
                id: routeId(route.name),
                name: route.name,
                color: route.color,
                textColor: '#111111',
                shape: 'AUTO' as const,
                icon: null,
                order: index,
                depots: route.depots.map(depotId)
            })),
            depots: DEFAULT_DEPOTS.map((depot) => ({
                id: depotId(depot.number),
                number: depot.number,
                name: depot.name,
                color: depot.color
            }))
        }
    }

    /**
     * Classifies a pasted vehicle list.
     *
     * The same two decisions the room makes on import — which list a vehicle
     * belongs in, and which depot the spawn name means — and nothing else. The
     * board reconciles the result against what it already holds, keeping the
     * dispatch state of vehicles that are still there, exactly as the room
     * does when it re-imports.
     */
    static classify(payload: ToolsModel.dispatchImportBody): ToolsModel.dispatchVehicleList {
        const solverContext = context(new Map())

        return payload.map((vehicle) => {
            const rule = matchRule(vehicle.Name, solverContext)
            const category: VehicleCategory = rule?.category ?? inferCategory(vehicle.Name)

            return {
                id: vehicle.Id.toString(),
                ownerId: vehicle.OwnerId.toString(),
                name: vehicle.Name,
                depot: vehicle.Depot,
                depotId: resolveDepotId(vehicle.Depot, solverContext),
                category
            }
        })
    }

    /**
     * Assigns routes, by the rules the group board uses.
     *
     * The whole board is sent up on every solve because it has to be: the
     * solver spreads vehicles across routes, so it needs to see what the
     * others are already carrying. `vehicleIds` still narrows what may move.
     */
    static async solve(body: ToolsModel.dispatchSolveBody, session: session): Promise<ToolsModel.dispatchSolveResponse> {
        const solverContext = context(await ownPreferences(session))

        const vehicles: SolverVehicle[] = body.vehicles.map((vehicle) => ({
            id: vehicle.id,
            ownerId: vehicle.ownerId,
            name: vehicle.name,
            depot: vehicle.depot,
            depotId: vehicle.depotId ?? resolveDepotId(vehicle.depot, solverContext),
            route: vehicle.route ?? null,
            category: vehicle.category
        }))

        const result = solve(vehicles, solverContext, {
            includeAssigned: body.includeAssigned,
            only: body.vehicleIds?.length ? body.vehicleIds : undefined
        })

        return {
            solved: result.assignments.length,
            skipped: result.skipped,
            assignments: result.assignments
        }
    }
}
