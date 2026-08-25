import { eq } from 'drizzle-orm'
import db from '../db'
import { depots, routeDepots, routes, vehicleRules } from '../db/schema'
import type { VehicleCategory } from '../db/schema'
import { childSlug } from '../utils/slug'

/**
 * What every new group starts with.
 *
 * These mirror the game itself rather than any one group's preferences, which
 * is why they are seeded rather than left to each group to recreate by hand.
 * Built-in routes can be disabled but never deleted — a group that removed one
 * would have no way to bring it back.
 */

export const DEFAULT_DEPOTS = [
    { number: 1, name: 'Main Island', color: '#4287f5', aliases: [] },
    // Formerly Hardbass Island. The rename landed in game, but old builds and
    // saved vehicle lists still report the previous spawn name.
    { number: 2, name: 'Cat Island', color: '#e0559a', aliases: ['Hardbass Island'] }
] as const

export const BUILT_IN_ROUTES = [
    { name: '6', color: '#d5a55d', depots: [2] },
    { name: '9', color: '#64ce7b', depots: [2] },
    { name: '10', color: '#bbce64', depots: [1, 2] },
    { name: '14', color: '#6e6ec4', depots: [1] },
    { name: '16', color: '#c86a6a', depots: [1] }
] as const

/**
 * The vehicles the game ships with, and which list each one belongs in.
 *
 * A dispatcher sorts by what a vehicle *is*, not by what its name happens to
 * contain, so the category is data a group edits rather than a keyword guess.
 * The guess (`inferCategory`) still exists for a model nobody has classified
 * yet — a new tram appearing mid-shift lands somewhere sensible instead of
 * nowhere.
 *
 * Names are matched exactly and case-insensitively. Both spellings of the
 * Sputnik are listed because the legacy dispatcher pinned "VAZ-2109" while the
 * list this was seeded from says "VAZ-2019", and an unmatched staff car would
 * otherwise be offered passenger routes.
 */
export const DEFAULT_VEHICLE_TYPES: Array<{ name: string; category: VehicleCategory }> = [
    { name: 'ZiU-682 (ZiU-9) Service Vehicle', category: 'SERVICE' },

    { name: 'VAZ-2019 Sputnik', category: 'STAFF' },
    { name: 'VAZ-2109 Sputnik', category: 'STAFF' },
    { name: '(NonRP) Tow Scooter', category: 'STAFF' },
    { name: '(NonRP) Tow ScooterHeavy', category: 'STAFF' },
    { name: 'Boat', category: 'STAFF' },

    { name: 'ZiU-682 (ZiU-9)', category: 'TROLLEYBUS' },
    { name: 'ZiU-682 (ZiU-9) EMU', category: 'TROLLEYBUS' },
    { name: 'ZiU-6205 (ZiU-10)', category: 'TROLLEYBUS' },
    { name: '(EmptyBase) Monorail', category: 'TROLLEYBUS' },
    { name: '(TrP Classic Port) Tatra T6B5 (T3M)', category: 'TROLLEYBUS' },
    { name: '(TrP Classic Port) Tatra T6B5 (T3M) EMU', category: 'TROLLEYBUS' }
]

/** Seeds the standard depots, routes and vehicle types. Safe to run more than once. */
export async function seedGroupDefaults(groupId: string) {
    const existingDepots = await db.select({ number: depots.number }).from(depots).where(eq(depots.groupId, groupId))
    const haveDepot = new Set(existingDepots.map((depot) => depot.number))

    for (const [index, depot] of DEFAULT_DEPOTS.entries()) {
        if (haveDepot.has(depot.number)) continue

        await db.insert(depots).values({
            groupId,
            number: depot.number,
            name: depot.name,
            slug: childSlug('depot', depot.name, depot.number),
            aliases: [...depot.aliases],
            color: depot.color,
            order: index
        })
    }

    const depotRows = await db
        .select({ id: depots.id, number: depots.number })
        .from(depots)
        .where(eq(depots.groupId, groupId))

    const depotIdByNumber = new Map(depotRows.map((depot) => [depot.number, depot.id]))

    const existingRoutes = await db.select({ name: routes.name }).from(routes).where(eq(routes.groupId, groupId))
    const haveRoute = new Set(existingRoutes.map((route) => route.name))

    // An even split across the built-ins is the sane starting point; groups
    // tune the percentages from the routes screen.
    const share = Math.floor(100 / BUILT_IN_ROUTES.length)

    for (const [index, route] of BUILT_IN_ROUTES.entries()) {
        if (haveRoute.has(route.name)) continue

        const [created] = await db
            .insert(routes)
            .values({
                groupId,
                name: route.name,
                slug: childSlug('route', route.name, index + 1),
                description: '',
                color: route.color,
                shape: 'CIRCLE',
                targetShare: share,
                builtIn: true,
                order: index,
                visibility: 'PUBLIC',
                // Readable, but kept off the group's public page: the routes
                // every group has say nothing about this one, and a page that
                // opens with five identical roundels buries the custom routes
                // underneath them.
                showOnGroupPage: false
            })
            .returning({ id: routes.id })

        if (!created) continue

        const links = route.depots
            .map((number) => depotIdByNumber.get(number))
            .filter((id): id is string => Boolean(id))
            .map((depotId) => ({ routeId: created.id, depotId }))

        if (links.length > 0) await db.insert(routeDepots).values(links)
    }

    await seedVehicleTypes(groupId)
}

/**
 * Gives a group the game's own vehicles to start from.
 *
 * Only when it has none. Topping the list up row by row sounds friendlier and
 * is not: a group that deletes a vehicle it does not run would find it back on
 * the next page load, because "missing" and "deliberately removed" look
 * identical from here. So this is a first-run backfill — it also covers groups
 * registered before vehicle types existed — and after that the table is
 * entirely the group's.
 */
export async function seedVehicleTypes(groupId: string) {
    const [existing] = await db
        .select({ id: vehicleRules.id })
        .from(vehicleRules)
        .where(eq(vehicleRules.groupId, groupId))
        .limit(1)

    if (existing) return

    await db.insert(vehicleRules).values(
        DEFAULT_VEHICLE_TYPES.map((type, index) => ({
            groupId,
            pattern: type.name,
            category: type.category,
            fixedRoute: null,
            order: index
        }))
    )
}
