import { status } from 'elysia'
import { and, asc, eq } from 'drizzle-orm'
import db from '../db'
import { depots, routes } from '../db/schema'
import { loadPendingApplications } from '../applications/service'
import { describeGroup, findGroup, summarise } from '../groups/service'
import { mediaUrls } from '../media/urls'
import { groupIndexKey } from '../rooms/service'
import { GetMemberships, permissionCacheKey } from '../utils/groupPermission'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { ELEVATED } from '../utils/membershipRule'
import { has, PERM } from '../utils/permissions'
import { dataRedis } from '../utils/redis'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { presentTranslations } from '../utils/translations'
import type { DashboardModel } from './model'
import { dashboardSchedules } from './shifts'

/** The overview uses badges and totals; galleries and signup identities belong on their own pages. */
export async function groupOverview(idOrSlug: string, session: session): Promise<DashboardModel.groupPageData> {
    if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
    const group = await findGroup(idOrSlug)
    if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

    const elevated = isSiteAdmin(session)
    const keys = elevated
        ? [groupIndexKey(group.id)]
        : [permissionCacheKey(group.id, session.user.userId), groupIndexKey(group.id)]
    const cached = await dataRedis.mget(keys).catch(() => [] as Array<string | null>)
    const memberships = elevated
        ? new Map([[group.id, ELEVATED]])
        : await GetMemberships(session.user.userId, [group.id], cached.slice(0, 1))
    const membership = memberships.get(group.id)!
    if (membership.permissionLevel < PERMISSION.DISPATCH) {
        throw status(group.visibility === 'PRIVATE' ? 404 : 403,
            group.visibility === 'PRIVATE' ? 'Not Found' : 'Forbidden')
    }

    const from = new Date()
    const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000)
    const eventCounts = new Map<string, number>()
    const [routeRows, depotRows, schedules, applicants] = await Promise.all([
        db.select({
            id: routes.id, name: routes.name, translations: routes.translations,
            color: routes.color, textColor: routes.textColor, shape: routes.shape, iconMediaId: routes.iconMediaId
        }).from(routes).where(and(eq(routes.groupId, group.id), eq(routes.archived, false)))
            .orderBy(asc(routes.order), asc(routes.name)),
        db.select({
            id: depots.id, number: depots.number, name: depots.name, translations: depots.translations,
            color: depots.color, iconMediaId: depots.iconMediaId
        }).from(depots).where(and(eq(depots.groupId, group.id), eq(depots.archived, false)))
            .orderBy(asc(depots.order), asc(depots.number)),
        dashboardSchedules([summarise(group, membership)], session, Promise.resolve(memberships), from, to, 5, eventCounts),
        has(membership.permissions, PERM.REVIEW_APPLICATIONS)
            ? loadPendingApplications(group.id, 6) : Promise.resolve([])
    ])

    // Resolve every displayed icon and the group banner in one media read.
    const images = await mediaUrls([
        group.bannerMediaId, ...routeRows.map((row) => row.iconMediaId), ...depotRows.map((row) => row.iconMediaId)
    ])
    return {
        group: await describeGroup(group, membership, session, images),
        overview: {
            routes: routeRows.map(({ iconMediaId, ...row }) => ({
                ...row, translations: presentTranslations('ROUTE', row.translations),
                icon: iconMediaId ? images.get(iconMediaId) ?? null : null
            })),
            depots: depotRows.map(({ iconMediaId, ...row }) => ({
                ...row, translations: presentTranslations('DEPOT', row.translations),
                icon: iconMediaId ? images.get(iconMediaId) ?? null : null
            })),
            shiftCount: eventCounts.get(group.id) ?? 0,
            upcoming: schedules[0] ?? [],
            applicants,
            openRoomId: has(membership.permissions, PERM.DISPATCH) ? cached.at(-1) ?? null : null
        }
    }
}
