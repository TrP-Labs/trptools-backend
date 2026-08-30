import { status } from 'elysia'
import { and, count, eq, inArray } from 'drizzle-orm'
import db from '../db'
import { applications, applicationSubmissions, users } from '../db/schema'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { dataRedis } from '../utils/redis'
import type { session } from '../utils/sessionVerifier'
import { Group_ } from '../groups/service'
import { Schedule } from '../schedule/service'
import { groupIndexKey } from '../rooms/service'
import type { ScheduleModel } from '../schedule/model'
import type { GroupModel } from '../groups/model'
import { DashboardModel } from './model'

/**
 * How far ahead the dashboard looks, and how much of it it keeps.
 *
 * A fortnight is the horizon a driver plans against; anything past it belongs
 * on the shifts page, which is what the "see all" link is for. The per-group
 * cap stops one group running a daily service from filling the whole list
 * before another group's weekly one is reached.
 */
const HORIZON_DAYS = 14
const PER_GROUP = 6
const TOTAL_SHIFTS = 12

/**
 * How many groups get a card, and with it a live schedule.
 *
 * Filling one in costs a membership lookup against Roblox, and a site admin
 * running with admin mode on holds *every* group on the instance — which
 * without a cap would mean a dashboard load that exhausts the Open Cloud quota
 * on its own. The full list is one link away at `/dashboard`, which needs no
 * such lookup.
 */
const MAX_GROUPS = 12

function withGroup(
    occurrence: ScheduleModel.occurrenceResponse,
    group: GroupModel.groupSummary,
    userId: string
): DashboardModel.upcomingShift {
    let filled = 0
    let capacity = 0
    let signedUp = false

    for (const sheet of occurrence.sheets) {
        for (const slot of sheet.slots) {
            filled += slot.signups.length
            capacity += slot.capacity
            if (slot.signups.some((signup) => signup.userId === userId)) signedUp = true
        }
    }

    return {
        eventId: occurrence.eventId,
        name: occurrence.name,
        slug: occurrence.slug,
        color: occurrence.color,
        start: occurrence.start,
        end: occurrence.end,
        groupId: group.id,
        groupSlug: group.slug,
        groupName: group.name,
        groupIcon: group.icon,
        signedUp,
        signupsOpen: occurrence.signupsOpen,
        sheetsAvailable: occurrence.sheetsAvailable,
        filled,
        capacity
    }
}

export abstract class Dashboard {
    /**
     * Everything the signed-in home page draws, in one request.
     *
     * The shifts page fans out over HTTP because it only needs one thing per
     * group; the dashboard needs three, and doing that from the browser would
     * be a request per group per card. Gathering it here costs the same
     * database work and one round trip.
     *
     * Nothing here decides access on its own. The group list, the schedule and
     * the application queue are each read through the service that owns them,
     * so a group the viewer cannot act in is absent for exactly the same
     * reason it is absent everywhere else — including for a site admin who has
     * not turned admin mode on.
     */
    static async get(session: session): Promise<DashboardModel.dashboardResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const userId = session.user.userId

        const [all, pinned] = await Promise.all([
            Group_.getGroups(session),
            db.select({ primaryGroupId: users.primaryGroupId }).from(users).where(eq(users.id, userId)).limit(1)
        ])

        if (all.length === 0) {
            return { primaryGroupId: null, groups: [], groupTotal: 0, shifts: [], reviews: [] }
        }

        // A pin survives losing access to what it points at — an afternoon
        // without a rank, or a pin made while admin mode was on — but must not
        // render a card the viewer cannot open.
        const pin = pinned[0]?.primaryGroupId ?? null
        const primaryGroupId = all.some((group) => group.id === pin) ? pin : null

        // The pinned group leads, and so is never the one the cap drops.
        const groups = [...all]
            .sort((a, b) => Number(b.id === primaryGroupId) - Number(a.id === primaryGroupId))
            .slice(0, MAX_GROUPS)

        const from = new Date()
        const to = new Date(from.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000)

        const manageable = groups.filter((group) => group.permissionLevel >= PERMISSION.MANAGE)

        const [schedules, rooms, reviews] = await Promise.all([
            Promise.all(
                groups.map(async (group) => {
                    // A group whose schedule cannot be read is not an error on
                    // somebody else's dashboard — it just has no shifts on it.
                    const occurrences = await Schedule.getOccurrences(
                        {
                            groupId: group.id,
                            from: from.toISOString(),
                            to: to.toISOString(),
                            limit: String(PER_GROUP)
                        },
                        session
                    ).catch(() => [] as ScheduleModel.occurrencesResponse)

                    return occurrences.map((occurrence) => withGroup(occurrence, group, userId))
                })
            ),
            dataRedis.mget(groups.map((group) => groupIndexKey(group.id))).catch(() => []),
            Dashboard.reviewQueue(manageable)
        ])

        const openRooms = new Map(groups.map((group, index) => [group.id, rooms[index] ?? null]))
        const pendingByGroup = new Map<string, number>()
        for (const review of reviews) {
            pendingByGroup.set(review.groupId, (pendingByGroup.get(review.groupId) ?? 0) + review.pendingCount)
        }

        const shifts = schedules
            .flat()
            .sort((a, b) => a.start.getTime() - b.start.getTime())
            .slice(0, TOTAL_SHIFTS)

        // `schedules` was built by mapping `groups`, so the two line up.
        const nextByGroup = new Map<string, DashboardModel.upcomingShift>()
        groups.forEach((group, index) => {
            const next = schedules[index]?.[0]
            if (next) nextByGroup.set(group.id, next)
        })

        return {
            primaryGroupId,
            groupTotal: all.length,
            groups: groups.map((group) => ({
                ...group,
                roomId: openRooms.get(group.id) ?? null,
                pendingApplications: pendingByGroup.get(group.id) ?? 0,
                nextShift: nextByGroup.get(group.id) ?? null
            })),
            shifts,
            reviews
        }
    }

    /**
     * Forms with somebody waiting on a decision, across the groups the viewer
     * manages.
     *
     * One query rather than a call per group: the permission that decides
     * which groups belong here has already been resolved by `getGroups`, and
     * asking the applications service per group would repeat that check —
     * and its group lookup — for every card on the page.
     */
    private static async reviewQueue(
        manageable: GroupModel.groupSummary[]
    ): Promise<DashboardModel.pendingReview[]> {
        if (manageable.length === 0) return []

        const rows = await db
            .select({
                applicationId: applications.id,
                name: applications.name,
                color: applications.color,
                groupId: applications.groupId,
                pendingCount: count(applicationSubmissions.id)
            })
            .from(applications)
            .innerJoin(
                applicationSubmissions,
                and(
                    eq(applicationSubmissions.applicationId, applications.id),
                    eq(applicationSubmissions.status, 'PENDING')
                )
            )
            .where(
                inArray(
                    applications.groupId,
                    manageable.map((group) => group.id)
                )
            )
            .groupBy(applications.id, applications.name, applications.color, applications.groupId)

        const byId = new Map(manageable.map((group) => [group.id, group]))

        return rows
            .map((row) => {
                const group = byId.get(row.groupId)!

                return {
                    applicationId: row.applicationId,
                    name: row.name,
                    color: row.color,
                    pendingCount: Number(row.pendingCount),
                    groupId: group.id,
                    groupSlug: group.slug,
                    groupName: group.name,
                    groupIcon: group.icon
                }
            })
            .sort((a, b) => b.pendingCount - a.pendingCount)
    }
}
