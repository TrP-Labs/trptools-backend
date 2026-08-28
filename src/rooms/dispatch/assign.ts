import type { VehicleCategory } from '../../db/schema'

/**
 * Automatic route assignment — the decisions, with nothing behind them.
 *
 * This half of the solver imports a type and nothing else, so it can be tested
 * without a database or an environment. `solver.ts` next door is the half that
 * reads a group out of Postgres and hands it here; importing *that* pulls in
 * `env.ts`, which throws when the environment is not set, and a test suite in
 * CI has no environment.
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
 *
 * Drivers who marked a favourite are placed **first**, in a pass of their own.
 * Order matters because shares are a finite thing to spend: with one pass in
 * vehicle order, a driver with no opinion could fill the route somebody else
 * had asked for, and the share left over pushed *other* people off the routes
 * they had asked for in turn. Placing the requests first and letting everybody
 * else fill in around them satisfies the same preferences while keeping the
 * spread closer to what the group configured.
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
    /** Exact lowercased vehicle name → the group's classification of it. */
    typesByName: Map<string, { pattern: string; category: VehicleCategory; fixedRoute: string | null }>
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

/**
 * Which list a vehicle belongs in, according to the group.
 *
 * An exact name match wins before anything else. A group's vehicle table is a
 * list of the models the game actually reports, and "ZiU-682 (ZiU-9)" read as
 * a pattern would happily also claim "ZiU-682 (ZiU-9) Service Vehicle" — the
 * substring that follows it — which is precisely backwards. Patterns are still
 * honoured after that, so a group that wrote one keeps it.
 */
export function matchRule(name: string, context: SolverContext) {
    const exact = context.typesByName.get(name.trim().toLowerCase())
    if (exact) return exact

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

/**
 * The `route` value that means "this vehicle carries a written note".
 *
 * A dispatcher who has told a driver something other than a route — sitting in
 * the depot, running empty to Cat Island — needs that to survive a solve, so
 * it lives in the same field as a route rather than beside it, where the
 * solver would have to be told about it separately in order to leave it alone.
 */
export const NOTE_ROUTE = 'NOTE'

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
 *
 * `only` narrows what gets *reassigned* without narrowing what gets *counted*.
 * Solving one vehicle from its own row has to see the rest of the board, or a
 * board with every route already covered would look empty to it and it would
 * pick whichever route has the largest share every time.
 */
export function solve(
    vehicles: SolverVehicle[],
    context: SolverContext,
    options: { includeAssigned?: boolean; only?: string[] } = {}
): SolveResult {
    const eligible = context.routes.filter((route) => route.autoAssign)

    const load = new Map<string, number>()
    for (const route of eligible) load.set(route.id, 0)

    const targets: SolverVehicle[] = []
    const only = options.only ? new Set(options.only) : null

    for (const vehicle of vehicles) {
        // A written note is a dispatcher's own words, so even "reassign
        // everything" leaves it alone; overwriting it would silently discard
        // the one thing on the row nothing else can reconstruct.
        if (vehicle.route === NOTE_ROUTE) continue

        const alreadyAssigned = vehicle.route !== null && vehicle.route !== ''

        if ((only && !only.has(vehicle.id)) || (alreadyAssigned && !options.includeAssigned)) {
            // Count it against the route it holds so the spread stays honest.
            if (load.has(vehicle.route!)) load.set(vehicle.route!, load.get(vehicle.route!)! + 1)
            continue
        }

        targets.push(vehicle)
    }

    const assignments: SolveResult['assignments'] = []
    let skipped = 0

    /**
     * The vehicles that are actually going to be given a passenger route,
     * with the routes each one can reach worked out once.
     *
     * Working this out up front is what makes two passes possible: whether a
     * driver asked for one of the routes their depot serves cannot be known
     * without the pool, and the whole point of the first pass is to place
     * those drivers before anybody else spends the share they need.
     */
    const placeable: Array<{ vehicle: SolverVehicle; pool: SolverRoute[]; favourite: SolverRoute[] }> = []

    for (const vehicle of targets) {
        const rule = matchRule(vehicle.name, context)

        // A rule with a fixed label wins outright — this is how service and
        // staff vehicles stay off the passenger routes.
        if (rule?.fixedRoute) {
            assignments.push({ vehicleId: vehicle.id, route: rule.fixedRoute })
            continue
        }

        // `skipped` means "should have had a route and got none", which is
        // what the dispatch page turns into a warning about depots. A service
        // van or a piece of scenery was never a candidate, so counting it here
        // reported a perfectly solved room as a misconfigured one.
        const category = rule?.category ?? vehicle.category ?? inferCategory(vehicle.name)
        if (category === 'SERVICE' || category === 'STAFF') continue

        // Decorative vehicles are placed by the map, not driven by anybody.
        if (vehicle.ownerId === '0') continue

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

        placeable.push({
            vehicle,
            pool,
            favourite: preference ? pool.filter((route) => preference.favourite.has(route.id)) : []
        })
    }

    /**
     * Places one vehicle on the best route left to it.
     *
     * A driver's own ranking comes first and the share only decides *within*
     * whichever tier they land in: a favourite is honoured even when that
     * route is already carrying more than its share, because a driver asking
     * for a route is a stronger signal than a number a manager typed. The
     * ordering above is what stops that from wrecking the spread.
     */
    function place({ vehicle, pool, favourite }: (typeof placeable)[number]) {
        const preference = context.preferences.get(vehicle.ownerId)
        const neutral = pool.filter(
            (route) => !preference?.favourite.has(route.id) && !preference?.disliked.has(route.id)
        )
        const disliked = pool.filter((route) => preference?.disliked.has(route.id))

        // A disliked route is the last resort, and only reached when the
        // driver's depot serves nothing else.
        const tier = favourite.length > 0 ? favourite : neutral.length > 0 ? neutral : disliked

        // Shares are relative to whichever routes this depot can reach, so a
        // depot served by two 20% routes still splits them evenly rather than
        // leaving 60% of its vehicles unassigned.
        const shareTotal = pool.reduce((sum, route) => sum + Math.max(route.targetShare, 0), 0)
        const placed = pool.reduce((sum, route) => sum + (load.get(route.id) ?? 0), 0) + 1

        function deficit(route: SolverRoute): number {
            // With no shares configured anywhere, fall back to an even spread.
            const share = shareTotal > 0 ? Math.max(route.targetShare, 0) / shareTotal : 1 / pool.length
            return share * placed - (load.get(route.id) ?? 0)
        }

        const chosen = shuffle(tier).reduce((best, route) => {
            return deficit(route) > deficit(best) ? route : best
        }, tier[0]!)

        load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1)
        assignments.push({ vehicleId: vehicle.id, route: chosen.id })
    }

    // First dibs: everybody who asked for one of the routes their depot serves.
    for (const candidate of placeable) if (candidate.favourite.length > 0) place(candidate)
    // Then everybody else, filling in around what the requests took.
    for (const candidate of placeable) if (candidate.favourite.length === 0) place(candidate)

    return { assignments, skipped }
}
