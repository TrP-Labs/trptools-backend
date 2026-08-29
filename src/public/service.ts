import { status } from 'elysia'
import { and, asc, count, eq, ilike, inArray, ne, or } from 'drizzle-orm'
import db from '../db'
import {
    depots,
    events,
    groups,
    rankRelations,
    routeDepots,
    routes,
    type Depot,
    type Group,
    type Route
} from '../db/schema'
import { globalModel } from '../utils/globalModel'
import { describeRule, occurrencesBetween } from '../utils/recurrence'
import { Roblox } from '../utils/roblox'
import { mediaForOwners, mediaUrls } from '../media/service'
import type { MediaModel } from '../media/model'
import type { RouteModel } from '../groups/routes/model'
import { openApplicationsFor } from '../applications/service'
import { PublicModel } from './model'

/**
 * Anonymous, cache-friendly reads of whatever a group has chosen to publish.
 *
 * Nothing here consults the session on purpose: these responses are identical
 * for every caller, which is what makes them safe to cache at the edge. Any
 * data a group has not marked public — or that moderation has withheld — never
 * enters the query.
 */
/** The published group behind a slug, or 404. */
async function publishedGroup(slug: string) {
    const [group] = await db.select().from(groups).where(eq(groups.slug, slug)).limit(1)

    // UNLISTED groups are reachable by direct link but never listed.
    // HIDDEN ones are withheld entirely until an admin reviews them.
    if (!group || group.visibility === 'PRIVATE' || group.moderation === 'HIDDEN') {
        throw status(404, 'Not Found' satisfies globalModel.notFound)
    }

    return group
}

function header(group: Group): PublicModel.groupHeader {
    return {
        id: group.id,
        slug: group.slug,
        name: group.cachedName ?? `Group ${group.robloxId}`,
        icon: group.cachedIcon,
        tagline: group.tagline,
        accentColor: group.accentColor
    }
}

/** Only routes and depots the group has actually published are readable. */
const publishedRoute = (groupId: string) =>
    and(
        eq(routes.groupId, groupId),
        eq(routes.archived, false),
        eq(routes.visibility, 'PUBLIC'),
        ne(routes.moderation, 'HIDDEN')
    )

const publishedDepot = (groupId: string) =>
    and(
        eq(depots.groupId, groupId),
        eq(depots.archived, false),
        eq(depots.visibility, 'PUBLIC'),
        ne(depots.moderation, 'HIDDEN')
    )

function presentRoute(
    route: Route,
    depotIds: string[],
    images: Map<string, MediaModel.item[]>,
    icons: Map<string, string>
): RouteModel.routeBody {
    return {
        ...route,
        icon: route.iconMediaId ? (icons.get(route.iconMediaId) ?? null) : null,
        depots: depotIds,
        images: (images.get(route.id) ?? []).filter((image) => image.id !== route.iconMediaId)
    }
}

function presentDepot(
    depot: Depot,
    images: Map<string, MediaModel.item[]>,
    icons: Map<string, string>
): RouteModel.depotBody {
    return {
        ...depot,
        icon: depot.iconMediaId ? (icons.get(depot.iconMediaId) ?? null) : null,
        images: (images.get(depot.id) ?? []).filter((image) => image.id !== depot.iconMediaId)
    }
}

export abstract class PublicPages {
    static async directory(query: PublicModel.directoryQuery): Promise<PublicModel.directory> {
        const limit = Math.min(Math.max(Number(query.limit ?? 60) || 60, 1), 100)
        const search = query.search?.trim()

        const visible = and(eq(groups.visibility, 'PUBLIC'), ne(groups.moderation, 'HIDDEN'))

        const where = search
            ? and(visible, or(ilike(groups.cachedName, `%${search}%`), ilike(groups.tagline, `%${search}%`)))
            : visible

        const rows = await db.select().from(groups).where(where).orderBy(asc(groups.cachedName)).limit(limit)

        if (rows.length === 0) return []

        const ids = rows.map((group) => group.id)

        const [routeCounts, depotCounts] = await Promise.all([
            db
                .select({ groupId: routes.groupId, total: count() })
                .from(routes)
                .where(
                    and(
                        inArray(routes.groupId, ids),
                        eq(routes.archived, false),
                        eq(routes.visibility, 'PUBLIC'),
                        ne(routes.moderation, 'HIDDEN')
                    )
                )
                .groupBy(routes.groupId),
            db
                .select({ groupId: depots.groupId, total: count() })
                .from(depots)
                .where(
                    and(
                        inArray(depots.groupId, ids),
                        eq(depots.archived, false),
                        eq(depots.visibility, 'PUBLIC'),
                        ne(depots.moderation, 'HIDDEN')
                    )
                )
                .groupBy(depots.groupId)
        ])

        const routeTotals = new Map(routeCounts.map((row) => [row.groupId, Number(row.total)]))
        const depotTotals = new Map(depotCounts.map((row) => [row.groupId, Number(row.total)]))

        return rows.map((group) => ({
            slug: group.slug,
            name: group.cachedName ?? `Group ${group.robloxId}`,
            icon: group.cachedIcon,
            tagline: group.tagline,
            accentColor: group.accentColor,
            members: group.cachedMembers ?? 0,
            routeCount: routeTotals.get(group.id) ?? 0,
            depotCount: depotTotals.get(group.id) ?? 0
        }))
    }

    static async groupPage(slug: string): Promise<PublicModel.groupPage> {
        const group = await publishedGroup(slug)

        // Listed on the page is narrower than published: a route or depot can
        // be public — readable at its own address, linked from anywhere — and
        // still be left out of the group's own listing.
        const publicRoutes = group.showRoutes
            ? await db
                  .select()
                  .from(routes)
                  .where(and(publishedRoute(group.id), eq(routes.showOnGroupPage, true)))
                  .orderBy(asc(routes.order), asc(routes.name))
            : []

        const publicDepots = await db
            .select()
            .from(depots)
            .where(and(publishedDepot(group.id), eq(depots.showOnGroupPage, true)))
            .orderBy(asc(depots.order), asc(depots.number))

        const [depotLinks, routeImages, depotImages, roster, upcomingShifts, openApplications] = await Promise.all([
            publicRoutes.length > 0
                ? db.select().from(routeDepots).where(
                      inArray(
                          routeDepots.routeId,
                          publicRoutes.map((route) => route.id)
                      )
                  )
                : Promise.resolve([]),
            mediaForOwners(
                'ROUTE',
                publicRoutes.map((route) => route.id)
            ),
            mediaForOwners(
                'DEPOT',
                publicDepots.map((depot) => depot.id)
            ),
            group.showRoster ? this.roster(group.id, group.robloxId) : Promise.resolve([]),
            group.showShifts ? this.upcomingShifts(group.id) : Promise.resolve([]),
            openApplicationsFor(group.id)
        ])

        const depotsByRoute = new Map<string, string[]>()
        for (const link of depotLinks) {
            const bucket = depotsByRoute.get(link.routeId) ?? []
            bucket.push(link.depotId)
            depotsByRoute.set(link.routeId, bucket)
        }

        const icons = await mediaUrls([
            ...publicRoutes.map((route) => route.iconMediaId),
            ...publicDepots.map((depot) => depot.iconMediaId)
        ])

        return {
            id: group.id,
            slug: group.slug,
            name: group.cachedName ?? `Group ${group.robloxId}`,
            icon: group.cachedIcon,
            bannerImage: group.bannerImage,
            description: group.cachedDescription ?? '',
            tagline: group.tagline,
            about: group.about,
            accentColor: group.accentColor,
            members: group.cachedMembers ?? 0,
            robloxId: group.robloxId,

            showRoutes: group.showRoutes,
            showShifts: group.showShifts,
            showRoster: group.showRoster,

            routes: publicRoutes.map((route) => presentRoute(route, depotsByRoute.get(route.id) ?? [], routeImages, icons)),
            depots: publicDepots.map((depot) => presentDepot(depot, depotImages, icons)),
            roster,
            upcomingShifts,
            openApplications
        }
    }

    static async routePage(slug: string, routeSlug: string): Promise<PublicModel.routePage> {
        const group = await publishedGroup(slug)
        if (!group.showRoutes) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const [route] = await db
            .select()
            .from(routes)
            .where(and(publishedRoute(group.id), eq(routes.slug, routeSlug)))
            .limit(1)

        if (!route) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const links = await db.select().from(routeDepots).where(eq(routeDepots.routeId, route.id))
        const depotIds = links.map((link) => link.depotId)

        const served =
            depotIds.length > 0
                ? await db
                      .select()
                      .from(depots)
                      .where(and(publishedDepot(group.id), inArray(depots.id, depotIds)))
                      .orderBy(asc(depots.order), asc(depots.number))
                : []

        const [images, icons] = await Promise.all([
            mediaForOwners('ROUTE', [route.id]),
            mediaUrls([route.iconMediaId, ...served.map((depot) => depot.iconMediaId)])
        ])

        return {
            group: header(group),
            route: presentRoute(route, depotIds, images, icons),
            depots: served.map((depot) => ({
                id: depot.id,
                slug: depot.slug,
                number: depot.number,
                name: depot.name,
                color: depot.color,
                icon: depot.iconMediaId ? (icons.get(depot.iconMediaId) ?? null) : null
            }))
        }
    }

    static async depotPage(slug: string, depotSlug: string): Promise<PublicModel.depotPage> {
        const group = await publishedGroup(slug)

        const [depot] = await db
            .select()
            .from(depots)
            .where(and(publishedDepot(group.id), eq(depots.slug, depotSlug)))
            .limit(1)

        if (!depot) throw status(404, 'Not Found' satisfies globalModel.notFound)

        // A route with no depot links serves every depot, so the listing is
        // "linked here, plus the ones that go everywhere".
        const candidates = group.showRoutes
            ? await db.select().from(routes).where(publishedRoute(group.id)).orderBy(asc(routes.order), asc(routes.name))
            : []

        const links =
            candidates.length > 0
                ? await db.select().from(routeDepots).where(
                      inArray(
                          routeDepots.routeId,
                          candidates.map((route) => route.id)
                      )
                  )
                : []

        const depotsByRoute = new Map<string, string[]>()
        for (const link of links) {
            const bucket = depotsByRoute.get(link.routeId) ?? []
            bucket.push(link.depotId)
            depotsByRoute.set(link.routeId, bucket)
        }

        const serving = candidates.filter((route) => {
            const linked = depotsByRoute.get(route.id) ?? []
            return linked.length === 0 || linked.includes(depot.id)
        })

        const [depotImages, routeImages, icons] = await Promise.all([
            mediaForOwners('DEPOT', [depot.id]),
            mediaForOwners(
                'ROUTE',
                serving.map((route) => route.id)
            ),
            mediaUrls([depot.iconMediaId, ...serving.map((route) => route.iconMediaId)])
        ])

        return {
            group: header(group),
            depot: presentDepot(depot, depotImages, icons),
            routes: serving.map((route) => presentRoute(route, depotsByRoute.get(route.id) ?? [], routeImages, icons))
        }
    }

    static async shiftPage(slug: string, shiftSlug: string): Promise<PublicModel.shiftPage> {
        const group = await publishedGroup(slug)
        if (!group.showShifts) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const [event] = await db
            .select()
            .from(events)
            .where(and(eq(events.groupId, group.id), eq(events.slug, shiftSlug), eq(events.visibility, 'PUBLIC')))
            .limit(1)

        if (!event) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const from = new Date()
        const to = new Date(from.getTime() + 60 * 24 * 60 * 60 * 1000)

        const occurrences = occurrencesBetween(event.rrule, event.startTime, event.duration, from, to, 20)

        return {
            group: header(group),
            shift: {
                eventId: event.eventId,
                slug: event.slug,
                name: event.name,
                description: event.description,
                color: event.color,
                duration: event.duration,
                recurrenceText: describeRule(event.rrule, event.startTime)
            },
            occurrences: occurrences.map((occurrence) => ({
                eventId: event.eventId,
                slug: event.slug,
                name: event.name,
                description: event.description,
                color: event.color,
                start: occurrence.start,
                end: occurrence.end
            }))
        }
    }

    /** Ranks marked visible, with the people holding them. */
    private static async roster(groupId: string, robloxId: string) {
        const visible = await db
            .select()
            .from(rankRelations)
            .where(and(eq(rankRelations.groupId, groupId), eq(rankRelations.visible, true)))

        if (visible.length === 0) return []

        const sorted = [...visible].sort((a, b) => b.cachedRank - a.cachedRank)

        return Promise.all(
            sorted.map(async (rank) => {
                const { total, members } = await Roblox.getRoleMembers(robloxId, rank.robloxId)
                const avatars = await Roblox.getAvatars(members.map((member) => member.userId))

                return {
                    rankId: rank.id,
                    name: rank.cachedName,
                    description: rank.description,
                    color: rank.color,
                    rank: rank.cachedRank,
                    memberCount: total,
                    members: members.map((member) => ({
                        robloxId: member.userId.toString(),
                        username: member.username,
                        displayName: member.displayName,
                        avatar: avatars.get(member.userId.toString()) ?? null
                    }))
                }
            })
        )
    }

    /**
     * How many future shifts a public group page lists.
     *
     * A count rather than a date range. A fortnight's window showed a group
     * that runs one event a month an empty schedule for most of the year,
     * while a daily service filled the same list with the same fortnight
     * repeated. Counting instead means the page always answers "what is on
     * next", whether that is tomorrow or in April.
     */
    private static readonly PUBLIC_SHIFT_COUNT = 6

    /**
     * The horizon the count is drawn from.
     *
     * Expansion still needs an end date, because a weekly rule with no UNTIL
     * is infinite. A year is far past the point anyone plans a game shift, so
     * in practice the count is what limits the list, not this.
     */
    private static readonly PUBLIC_SHIFT_HORIZON_DAYS = 365

    private static async upcomingShifts(groupId: string) {
        const rows = await db
            .select()
            .from(events)
            .where(and(eq(events.groupId, groupId), eq(events.visibility, 'PUBLIC')))

        if (rows.length === 0) return []

        const from = new Date()
        const to = new Date(from.getTime() + this.PUBLIC_SHIFT_HORIZON_DAYS * 24 * 60 * 60 * 1000)

        // Every schedule is expanded to its own next few, then merged and cut
        // back to the soonest overall — so the list is genuinely "what is on
        // next", not the first schedule's diary.
        const expanded = rows.flatMap((event) =>
            occurrencesBetween(
                event.rrule,
                event.startTime,
                event.duration,
                from,
                to,
                this.PUBLIC_SHIFT_COUNT
            ).map((occurrence) => ({
                eventId: event.eventId,
                slug: event.slug,
                name: event.name,
                description: event.description,
                color: event.color,
                start: occurrence.start,
                end: occurrence.end
            }))
        )

        expanded.sort((a, b) => a.start.getTime() - b.start.getTime())

        return expanded.slice(0, this.PUBLIC_SHIFT_COUNT)
    }
}
