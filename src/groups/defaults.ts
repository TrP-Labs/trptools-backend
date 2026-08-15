import { eq } from 'drizzle-orm'
import db from '../db'
import { depots, routeDepots, routes } from '../db/schema'
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

/** Seeds the standard depots and routes. Safe to run more than once. */
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
                visibility: 'PUBLIC'
            })
            .returning({ id: routes.id })

        if (!created) continue

        const links = route.depots
            .map((number) => depotIdByNumber.get(number))
            .filter((id): id is string => Boolean(id))
            .map((depotId) => ({ routeId: created.id, depotId }))

        if (links.length > 0) await db.insert(routeDepots).values(links)
    }
}
