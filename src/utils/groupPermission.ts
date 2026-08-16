import { status } from 'elysia'
import { and, eq } from 'drizzle-orm'
import db from '../db'
import { groups, rankRelations, users } from '../db/schema'
import { Roblox } from './roblox'
import { resolveCredentials } from './robloxCredentials'
import { dataRedis } from './redis'
import { PERMISSION } from './globalModel'
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
 * Resolves what a user is inside a TrPTools group.
 *
 * Permission is always derived from the Roblox role the user currently holds,
 * mapped through the group's `rank_relations` table — TrPTools never stores a
 * permission grant that Roblox does not still back.
 *
 * The result is cached for a minute. Without that, a single dispatch session
 * would exhaust Roblox's Open Cloud quota in seconds.
 */
export async function GetMembership(userID: string, groupID: string): Promise<Membership> {
    const cacheKey = `perm:${groupID}:${userID}`

    try {
        const hit = await dataRedis.get(cacheKey)
        if (hit !== null) {
            const [level, rank] = hit.split(':')
            return { permissionLevel: Number(level), robloxRank: Number(rank) }
        }
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
    const membership = await Roblox.getMembership(user.robloxId, group.robloxId, credentials)

    if (!membership) {
        await dataRedis.set(cacheKey, `${PERMISSION.NONE}:-1`, 'EX', 30).catch(() => undefined)
        return NON_MEMBER
    }

    const [relation] = await db
        .select({ permissionLevel: rankRelations.permissionLevel, cachedRank: rankRelations.cachedRank })
        .from(rankRelations)
        .where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.robloxId, membership.role.id)))
        .limit(1)
        .catch(() => [])

    // A role Roblox reports but the group never bound still tells us the
    // user's standing, so the rank number comes from the membership itself.
    const resolved: Membership = {
        permissionLevel: relation?.permissionLevel ?? PERMISSION.NONE,
        robloxRank: relation?.cachedRank ?? membership.role.rank ?? -1
    }

    await dataRedis
        .set(cacheKey, `${resolved.permissionLevel}:${resolved.robloxRank}`, 'EX', 60)
        .catch(() => undefined)

    return resolved
}

export async function GetPermissionLevel(userID: string, groupID: string): Promise<number> {
    return (await GetMembership(userID, groupID)).permissionLevel
}

export default async function UserHasRank(userID: string, groupID: string, rank: number): Promise<boolean> {
    return (await GetPermissionLevel(userID, groupID)) >= rank
}

/** Throws 401/403 unless the session holds at least `level` in the group. */
export async function assertPermission(session: session, groupID: string, level: number) {
    if (!session.user) throw status(401, 'Unauthorized')
    if (session.user.siteRank === 'admin') return
    if (!(await UserHasRank(session.user.userId, groupID, level))) throw status(403, 'Forbidden')
}

/** Clears cached permission levels, e.g. after a rank binding changes. */
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
