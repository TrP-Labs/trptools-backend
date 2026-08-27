import { and, asc, eq, inArray } from 'drizzle-orm'
import db from '../../db'
import {
    depots,
    globalRoutePreferences,
    routeDepots,
    routePreferences,
    routes,
    users,
    vehicleRules
} from '../../db/schema'
import { depotKey, type SolverContext, type SolverRoute } from './assign'

/**
 * Loading a group's solver context.
 *
 * The decisions themselves live in `assign.ts`, which imports nothing that
 * touches the database — that separation is what makes them testable. This
 * file is re-exported from, so callers still import one module.
 */

export * from './assign'

/**
 * What each driver in a room has asked for, keyed by Roblox id.
 *
 * A vehicle carries the Roblox id of whoever spawned it, and a TrPTools
 * account carries the same id, so a driver's preferences are one join away
 * from a board that has never heard of them. Drivers without an account here
 * simply have no entry, which is the same as having no opinion.
 *
 * Shared with the dispatch board, which paints the same answers into the route
 * dropdown — the colours a dispatcher sees and the choices the solver makes
 * have to come from one query or they will eventually disagree.
 *
 * Two sources, resolved to the same thing. A custom route is marked by id; a
 * built-in is marked by name and applies in every group, so the group's own
 * copy of route 6 has to be found by its name before the solver can see the
 * mark at all.
 */
export async function loadRoutePreferences(
    groupRoutes: Array<{ id: string; name: string; builtIn: boolean }>,
    ownerRobloxIds: string[]
): Promise<Map<string, { favourite: Set<string>; disliked: Set<string> }>> {
    const preferences = new Map<string, { favourite: Set<string>; disliked: Set<string> }>()

    // Owner "0" is the game itself, and a vehicle spawned by the map has
    // nobody's opinion attached to it.
    const numericOwners = [...new Set(ownerRobloxIds)].map(Number).filter((id) => Number.isFinite(id) && id > 0)
    if (numericOwners.length === 0 || groupRoutes.length === 0) return preferences

    const routeIds = groupRoutes.map((route) => route.id)

    // This group's built-ins, by the name a global mark is held against.
    const builtInByName = new Map<string, string>()
    for (const route of groupRoutes) if (route.builtIn) builtInByName.set(route.name, route.id)

    function add(robloxId: string, routeId: string, preference: 'FAVORITE' | 'DISLIKE') {
        const entry = preferences.get(robloxId) ?? { favourite: new Set<string>(), disliked: new Set<string>() }
        if (preference === 'FAVORITE') entry.favourite.add(routeId)
        else entry.disliked.add(routeId)
        preferences.set(robloxId, entry)
    }

    const [rows, globalRows] = await Promise.all([
        db
            .select({
                robloxId: users.robloxId,
                routeId: routePreferences.routeId,
                preference: routePreferences.preference
            })
            .from(routePreferences)
            .innerJoin(users, eq(routePreferences.userId, users.id))
            .where(and(inArray(users.robloxId, numericOwners), inArray(routePreferences.routeId, routeIds))),
        builtInByName.size > 0
            ? db
                  .select({
                      robloxId: users.robloxId,
                      routeName: globalRoutePreferences.routeName,
                      preference: globalRoutePreferences.preference
                  })
                  .from(globalRoutePreferences)
                  .innerJoin(users, eq(globalRoutePreferences.userId, users.id))
                  .where(
                      and(
                          inArray(users.robloxId, numericOwners),
                          inArray(globalRoutePreferences.routeName, [...builtInByName.keys()])
                      )
                  )
            : []
    ])

    for (const row of rows) add(row.robloxId.toString(), row.routeId, row.preference)

    for (const row of globalRows) {
        const routeId = builtInByName.get(row.routeName)
        if (routeId) add(row.robloxId.toString(), routeId, row.preference)
    }

    return preferences
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

    const preferences = await loadRoutePreferences(routeRows, ownerRobloxIds)

    const rules = ruleRows.map((rule) => ({
        pattern: rule.pattern,
        category: rule.category,
        fixedRoute: rule.fixedRoute
    }))

    // The first row wins, matching how the list is ordered on screen.
    const typesByName = new Map<string, (typeof rules)[number]>()
    for (const rule of rules) {
        const key = rule.pattern.trim().toLowerCase()
        if (!typesByName.has(key)) typesByName.set(key, rule)
    }

    return {
        routes: solverRoutes,
        depotsByKey,
        rules,
        typesByName,
        preferences
    }
}

