import { status } from 'elysia'
import { and, eq } from 'drizzle-orm'
import db from '../db'
import { groups, rankRelations, users } from '../db/schema'
import { Roblox } from './roblox'
import { resolveCredentials } from './robloxCredentials'
import { dataRedis } from './redis'
import { PERMISSION } from './globalModel'
import { isUuid } from './slug'
import type { session } from './sessionVerifier'

/**
 * What a user is inside a TrPTools group: the permission level their bound
 * rank grants, and the Roblox rank number itself.
 *
 * `robloxRank` is Roblox's own 0-255 ordering. Permission levels are coarse
 * and deliberately unordered against it — two ranks can both be "dispatch"
 * — so rank-gated features such as staff sign-up sheets compare this instead.
 * It is -1 when the user holds no role in the group at all, which keeps a
 * non-member strictly below Roblox's lowest real rank of 0.
 */
export type Membership = {
    permissionLevel: number
    robloxRank: number
}

const NON_MEMBER: Membership = { permissionLevel: PERMISSION.NONE, robloxRank: -1 }

/**
 * A group's own id, whichever identifier the caller had to hand.
 *
 * Dashboard URLs carry a group's slug, so a slug is what reaches the services
 * that hand their route parameter straight to `assertPermission`. Matching one
 * against `groups.id` asks Postgres to read it as a uuid, which fails outright
 * rather than simply not matching — so the identifier is normalised before it
 * reaches a query or a cache key.
 */
async function resolveGroupId(idOrSlug: string): Promise<string | null> {
    if (isUuid(idOrSlug)) return idOrSlug

    const [group] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.slug, idOrSlug))
        .limit(1)
        .catch(() => [])

    return group?.id ?? null
}

const encode = (membership: Membership) => `${membership.permissionLevel}:${membership.robloxRank}`

function decode(value: string): Membership {
    const [level, rank] = value.split(':')
    return { permissionLevel: Number(level), robloxRank: Number(rank) }
}

/**
 * How long a last-known-good *Roblox role* stands in when Roblox cannot be
 * reached at all.
 *
 * This is the one place TrPTools acts on something Roblox has not just
 * confirmed, and it is deliberate: the alternative is that a rate-limited
 * legacy endpoint or a refused API key silently demotes everyone in the group
 * to nothing, which is exactly how group owners were losing their own
 * dashboard. Roblox answering "not a member" clears it immediately, so a real
 * demotion still takes effect within the minute.
 *
 * What is remembered is the **role id**, never the permission level it mapped
 * to. The level is re-derived from `rank_relations` on every fallback, so a
 * manager who changes what a rank grants still has that apply at once — even
 * mid-outage, and even to the person making the change. Storing the level
 * instead meant `invalidateGroupPermissions` had to throw the entry away to
 * stay correct, which locked an owner out again the moment they used it.
 */
const GRACE_TTL = 60 * 15

/**
 * Resolves what a user is inside a TrPTools group.
 *
 * Permission is always derived from the Roblox role the user currently holds,
 * mapped through the group's `rank_relations` table — TrPTools never stores a
 * permission grant that Roblox does not still back.
 *
 * The result is cached for a minute. Without that, a single dispatch session
 * would exhaust Roblox's Open Cloud quota in seconds. The cache is keyed by the
 * group's id and never its slug, so `invalidateGroupPermissions` clears every
 * entry for a group however the caller addressed it.
 */
export async function GetMembership(userID: string, groupIdOrSlug: string): Promise<Membership> {
    const groupID = await resolveGroupId(groupIdOrSlug)
    if (!groupID) return NON_MEMBER

    const cacheKey = `perm:${groupID}:${userID}`
    const graceKey = `perm:last:${groupID}:${userID}`

    try {
        const hit = await dataRedis.get(cacheKey)
        if (hit !== null) return decode(hit)
    } catch {
        // fall through
    }

    const [group] = await db
        .select({ id: groups.id, robloxId: groups.robloxId })
        .from(groups)
        .where(eq(groups.id, groupID))
        .limit(1)
        .catch(() => [])

    const [user] = await db
        .select({ robloxId: users.robloxId })
        .from(users)
        .where(eq(users.id, userID))
        .limit(1)
        .catch(() => [])

    if (!group || !user) return NON_MEMBER

    const credentials = await resolveCredentials(group.id, userID)
    const lookup = await Roblox.lookupMembership(user.robloxId, group.robloxId, credentials)

    if (lookup.status === 'UNKNOWN') {
        const remembered = await dataRedis.get(graceKey).catch(() => null)
        console.warn(
            `[roblox] membership lookup for user ${user.robloxId} in group ${group.robloxId} was inconclusive` +
                (remembered ? ' — standing in their last known role' : ' — no previous role to stand in')
        )

        if (!remembered) return NON_MEMBER

        // Nothing is written to `cacheKey`: the next request should ask Roblox
        // again rather than inherit a minute of guesswork.
        const [roleId, rank] = remembered.split(':')
        return resolveRole(group.id, roleId ?? '', Number(rank))
    }

    if (lookup.status === 'NOT_MEMBER') {
        await Promise.all([
            dataRedis.set(cacheKey, encode(NON_MEMBER), 'EX', 30).catch(() => undefined),
            dataRedis.unlink(graceKey).catch(() => undefined)
        ])
        return NON_MEMBER
    }

    const { role } = lookup.membership
    const resolved = await resolveRole(group.id, role.id, role.rank)

    await Promise.all([
        dataRedis.set(cacheKey, encode(resolved), 'EX', 60).catch(() => undefined),
        dataRedis.set(graceKey, `${role.id}:${role.rank}`, 'EX', GRACE_TTL).catch(() => undefined)
    ])

    return resolved
}

/**
 * What a Roblox role grants in a group, according to `rank_relations` as it
 * stands right now.
 */
async function resolveRole(groupID: string, roleId: string, reportedRank: number): Promise<Membership> {
    const [relation] = await db
        .select({ permissionLevel: rankRelations.permissionLevel, cachedRank: rankRelations.cachedRank })
        .from(rankRelations)
        .where(and(eq(rankRelations.groupId, groupID), eq(rankRelations.robloxId, roleId)))
        .limit(1)
        .catch(() => [])

    // A role Roblox reports but the group never bound still tells us the
    // user's standing, so the rank number falls back to the reported one.
    const robloxRank = relation?.cachedRank ?? reportedRank ?? -1

    // The Roblox owner role always holds full control, and that is settled
    // here rather than only where ranks are edited. A group whose owner row
    // drifted below manage — bound before the rule existed, or written by an
    // older seed — could not be repaired through the API, because editing rank
    // 255 deliberately drops any permission change. Pinning at the point
    // permission is *resolved* means such a group can never lock itself out.
    const permissionLevel =
        robloxRank >= 255 ? PERMISSION.MANAGE : (relation?.permissionLevel ?? PERMISSION.NONE)

    return { permissionLevel, robloxRank }
}

export async function GetPermissionLevel(userID: string, groupIdOrSlug: string): Promise<number> {
    return (await GetMembership(userID, groupIdOrSlug)).permissionLevel
}

export default async function UserHasRank(userID: string, groupIdOrSlug: string, rank: number): Promise<boolean> {
    return (await GetPermissionLevel(userID, groupIdOrSlug)) >= rank
}

/**
 * Throws 401/403 unless the session holds at least `level` in the group.
 *
 * The group may be named by id or by slug, because several services check
 * permission on their raw route parameter before resolving the group itself.
 */
export async function assertPermission(session: session, groupIdOrSlug: string, level: number) {
    if (!session.user) throw status(401, 'Unauthorized')
    if (session.user.siteRank === 'admin') return
    if (!(await UserHasRank(session.user.userId, groupIdOrSlug, level))) throw status(403, 'Forbidden')
}

/**
 * Clears cached permission levels, e.g. after a rank binding changes.
 *
 * The `perm:last:*` grace entries are deliberately left alone. They hold a
 * Roblox role id rather than a permission level, so the new binding applies to
 * them on the next fallback anyway — and clearing them would mean an owner who
 * edits a rank during a Roblox outage throws away the only thing keeping them
 * signed in to their own dashboard.
 */
export async function invalidateGroupPermissions(groupID: string) {
    const stream = dataRedis.scanStream({ match: `perm:${groupID}:*`, count: 500 })
    for await (const keys of stream) {
        if (keys.length) await dataRedis.unlink(...keys)
    }
}

/** Clears one user's cached permission level everywhere. */
export async function invalidateUserPermissions(userID: string) {
    const stream = dataRedis.scanStream({ match: `perm:*:${userID}`, count: 500 })
    for await (const keys of stream) {
        if (keys.length) await dataRedis.unlink(...keys)
    }
}
