import { and, asc, eq, inArray } from 'drizzle-orm'
import db from '../../db'
import { depots, routeDepots, routePreferences, routes, users, vehicleRules } from '../../db/schema'
import type { VehicleCategory } from '../../db/schema'

/**
 * Automatic route assignment.
 *
 * The legacy solver hardcoded five route numbers and a fixed depot-to-route
 * table, which is exactly why custom routes were never assignable. Here the
 * eligible set comes from the database: a route declares which depots it
 * serves, whether it takes automatic assignment, and how many vehicles it
 * holds. A group can add a route and it participates immediately.
 *
 * Each route declares the *share* of vehicles it should carry rather than a
 * hard cap. Shares are normalised across whichever routes a given vehicle's
 * depot actually serves, so they never have to add up to 100 and a depot with
 * only two routes still splits sensibly between them.
 *
 * Assignment prefers, in order:
 *   1. Routes the driver marked as a favourite.
 *   2. Routes the driver has no opinion about.
 *   3. Routes the driver dislikes, but only if nothing else is left.
 *
 * Within a tier it picks whichever route is furthest below its target share,
 * breaking ties randomly so repeated solves do not always favour the same one.
 */

export interface SolverVehicle {
    id: string
    ownerId: string
    name: string
    /** The spawn name exactly as the game reported it. */
    depot: string
    /** The depot row that name resolved to, or null when nothing matched. */
    depotId: string | null
    route: string | null
    category: VehicleCategory
}

export interface SolverRoute {
    id: string
    name: string
    autoAssign: boolean
    /** Percentage of vehicles this route should carry. */
    targetShare: number
    depotIds: Set<string>
    /** True when the route serves every depot. */
    servesAllDepots: boolean
}

export interface SolverContext {
    routes: SolverRoute[]
    /** Normalised depot spelling → depot id. */
    depotsByKey: Map<string, string>
    /** Regex-ish name rules that pin a vehicle to a label or category. */
    rules: Array<{ pattern: string; category: VehicleCategory; fixedRoute: string | null }>
    /** robloxId → { favourites, dislikes } as route ids. */
    preferences: Map<string, { favourite: Set<string>; disliked: Set<string> }>
}

/**
 * Reduces a depot name to something both sides can agree on.
 *
 * The game reports a spawn as "Main Island Depot" while groups name the depot
 * "Main Island". Comparing the raw strings matched nothing, which emptied
 * every route pool and made automatic assignment silently place nobody.
 * Stripping the word "depot", the punctuation and the case makes the common
 * case line up; anything still mismatched is covered by a depot's `aliases`.
 */
export function depotKey(name: string): string {
    return name
        .toLowerCase()
        .replace(/\bdepots?\b/g, '')
        .replace(/[^a-z0-9]+/g, '')
}

/** The depot a game-reported spawn name belongs to, if any. */
export function resolveDepotId(name: string, context: SolverContext): string | null {
    const key = depotKey(name)
    // "N/A" is what the game sends for a vehicle spawned outside a depot.
    if (!key || key === 'na') return null

    return context.depotsByKey.get(key) ?? null
}

/** Loads everything the solver needs for a group in a handful of queries. */
export async function loadSolverContext(groupId: string, ownerRobloxIds: string[]): Promise<SolverContext> {
    const [routeRows, depotRows, ruleRows] = await Promise.all([
        db
            .select()
            .from(routes)
            .where(and(eq(routes.groupId, groupId), eq(routes.archived, false)))
            .orderBy(asc(routes.order)),
        db.select().from(depots).where(eq(depots.groupId, groupId)),
        db.select().from(vehicleRules).where(eq(vehicleRules.groupId, groupId)).orderBy(asc(vehicleRules.order))
    ])

    // Every spelling a depot answers to: its own name, its aliases, and the
    // bare number the game sometimes reports instead.
    const depotsByKey = new Map<string, string>()
    for (const depot of depotRows) {
        for (const spelling of [depot.name, depot.number.toString(), ...depot.aliases]) {
            const key = depotKey(spelling)
            if (key) depotsByKey.set(key, depot.id)
        }
    }

    const links =
        routeRows.length > 0
            ? await db.select().from(routeDepots).where(
                  inArray(
                      routeDepots.routeId,
                      routeRows.map((route) => route.id)
                  )
              )
            : []

    const depotsByRoute = new Map<string, Set<string>>()
    for (const link of links) {
        const bucket = depotsByRoute.get(link.routeId) ?? new Set<string>()
        bucket.add(link.depotId)
        depotsByRoute.set(link.routeId, bucket)
    }

    const solverRoutes: SolverRoute[] = routeRows.map((route) => {
        const depotIds = depotsByRoute.get(route.id) ?? new Set<string>()
        return {
            id: route.id,
            name: route.name,
            autoAssign: route.autoAssign,
            targetShare: route.targetShare,
            depotIds,
            servesAllDepots: depotIds.size === 0
        }
    })

    // Map Roblox owner ids to TrPTools users so we can honour preferences for
    // drivers who have an account here.
    const preferences = new Map<string, { favourite: Set<string>; disliked: Set<string> }>()
    const numericOwners = ownerRobloxIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)

    if (numericOwners.length > 0 && routeRows.length > 0) {
        const rows = await db
            .select({
                robloxId: users.robloxId,
                routeId: routePreferences.routeId,
                preference: routePreferences.preference
            })
            .from(routePreferences)
            .innerJoin(users, eq(routePreferences.userId, users.id))
            .where(
                and(
                    inArray(users.robloxId, numericOwners),
                    inArray(
                        routePreferences.routeId,
                        routeRows.map((route) => route.id)
                    )
                )
            )

        for (const row of rows) {
            const key = row.robloxId.toString()
            const entry = preferences.get(key) ?? { favourite: new Set<string>(), disliked: new Set<string>() }
            if (row.preference === 'FAVORITE') entry.favourite.add(row.routeId)
            else entry.disliked.add(row.routeId)
            preferences.set(key, entry)
        }
    }

    return {
        routes: solverRoutes,
        depotsByKey,
        rules: ruleRows.map((rule) => ({
            pattern: rule.pattern,
            category: rule.category,
            fixedRoute: rule.fixedRoute
        })),
        preferences
    }
}

/** Matches a vehicle name against a group's rules. */
export function matchRule(name: string, context: SolverContext) {
    for (const rule of context.rules) {
        let matches = false

        try {
            // Patterns are authored by group managers, not the public, but a
            // malformed one still must not throw.
            matches = new RegExp(rule.pattern, 'i').test(name)
        } catch {
            matches = name.toLowerCase().includes(rule.pattern.toLowerCase())
        }

        if (matches) return rule
    }

    return null
}

/** Keyword fallback for groups that have not written any rules yet. */
export function inferCategory(name: string): VehicleCategory {
    const value = name.toLowerCase()
    if (/service|maintenance|rescue|utility|tow/.test(value)) return 'SERVICE'
    if (/staff|escort|sedan|sputnik|vaz/.test(value)) return 'STAFF'
    if (/trolley|bus|ziu|троллейбус/.test(value)) return 'TROLLEYBUS'
    return 'OTHER'
}

function shuffle<T>(items: T[]): T[] {
    const copy = [...items]
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1))
        ;[copy[index], copy[swap]] = [copy[swap]!, copy[index]!]
    }
    return copy
}

export interface SolveResult {
    assignments: Array<{ vehicleId: string; route: string | null }>
    skipped: number
}

/**
 * Assigns routes to vehicles.
 *
 * `load` starts from the routes already held by vehicles we are not
 * reassigning, so a partial solve tops up the existing spread rather than
 * ignoring it.
 */
export function solve(
    vehicles: SolverVehicle[],
    context: SolverContext,
    options: { includeAssigned?: boolean } = {}
): SolveResult {
    const eligible = context.routes.filter((route) => route.autoAssign)

    const load = new Map<string, number>()
    for (const route of eligible) load.set(route.id, 0)

    const targets: SolverVehicle[] = []

    for (const vehicle of vehicles) {
        const alreadyAssigned = vehicle.route !== null && vehicle.route !== ''

        if (alreadyAssigned && !options.includeAssigned) {
            // Count it against the route it holds so the spread stays honest.
            if (load.has(vehicle.route!)) load.set(vehicle.route!, load.get(vehicle.route!)! + 1)
            continue
        }

        targets.push(vehicle)
    }

    const assignments: SolveResult['assignments'] = []
    let skipped = 0

    for (const vehicle of targets) {
        const rule = matchRule(vehicle.name, context)

        // A rule with a fixed label wins outright — this is how service and
        // staff vehicles stay off the passenger routes.
        if (rule?.fixedRoute) {
            assignments.push({ vehicleId: vehicle.id, route: rule.fixedRoute })
            continue
        }

        const category = rule?.category ?? vehicle.category ?? inferCategory(vehicle.name)
        if (category === 'SERVICE' || category === 'STAFF') {
            skipped += 1
            continue
        }

        // A vehicle whose spawn is "N/A" or otherwise unrecognised is eligible
        // everywhere, matching the legacy dispatcher — refusing to place it
        // would leave it stranded for a depot the group never configured.
        const pool = vehicle.depotId
            ? eligible.filter((route) => route.servesAllDepots || route.depotIds.has(vehicle.depotId!))
            : eligible

        if (pool.length === 0) {
            skipped += 1
            continue
        }

        const preference = context.preferences.get(vehicle.ownerId)
        const favourite = pool.filter((route) => preference?.favourite.has(route.id))
        const neutral = pool.filter(
            (route) => !preference?.favourite.has(route.id) && !preference?.disliked.has(route.id)
        )
        const disliked = pool.filter((route) => preference?.disliked.has(route.id))

        const tier = favourite.length > 0 ? favourite : neutral.length > 0 ? neutral : disliked

        // Shares are relative to whichever routes this depot can reach, so a
        // depot served by two 20% routes still splits them evenly rather than
        // leaving 60% of its vehicles unassigned.
        const shareTotal = pool.reduce((sum, route) => sum + Math.max(route.targetShare, 0), 0)
        const placed = pool.reduce((sum, route) => sum + (load.get(route.id) ?? 0), 0) + 1

        const chosen = shuffle(tier).reduce((best, route) => {
            return deficit(route) > deficit(best) ? route : best
        }, tier[0]!)

        function deficit(route: SolverRoute): number {
            // With no shares configured anywhere, fall back to an even spread.
            const share = shareTotal > 0 ? Math.max(route.targetShare, 0) / shareTotal : 1 / pool.length
            return share * placed - (load.get(route.id) ?? 0)
        }

        load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1)
        assignments.push({ vehicleId: vehicle.id, route: chosen.id })
    }

    return { assignments, skipped }
}
