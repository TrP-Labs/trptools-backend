import { and, asc, eq, inArray } from 'drizzle-orm'
import db from '../../db'
import { depots, routeDepots, routePreferences, routes, users, vehicleRules } from '../../db/schema'
import { depotKey, type SolverContext, type SolverRoute } from './assign'

/**
 * Loading a group's solver context.
 *
 * The decisions themselves live in `assign.ts`, which imports nothing that
 * touches the database — that separation is what makes them testable. This
 * file is re-exported from, so callers still import one module.
 */

export * from './assign'

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

