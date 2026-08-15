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
 * Resolves the permission level a user holds inside a TrPTools group.
 *
 * Permission is always derived from the Roblox role the user currently holds,
 * mapped through the group's `rank_relations` table — TrPTools never stores a
 * permission grant that Roblox does not still back.
 *
 * The result is cached for a minute. Without that, a single dispatch session
 * would exhaust Roblox's Open Cloud quota in seconds.
 */
export async function GetPermissionLevel(userID: string, groupID: string): Promise<number> {
    const cacheKey = `perm:${groupID}:${userID}`

    try {
        const hit = await dataRedis.get(cacheKey)
        if (hit !== null) return Number(hit)
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

    if (!group || !user) return PERMISSION.NONE

    const credentials = await resolveCredentials(group.id, userID)
    const membership = await Roblox.getMembership(user.robloxId, group.robloxId, credentials)

    if (!membership) {
        await dataRedis.set(cacheKey, PERMISSION.NONE, 'EX', 30).catch(() => undefined)
        return PERMISSION.NONE
    }

    const [relation] = await db
        .select({ permissionLevel: rankRelations.permissionLevel })
        .from(rankRelations)
        .where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.robloxId, membership.role.id)))
        .limit(1)
        .catch(() => [])

    const level = relation?.permissionLevel ?? PERMISSION.NONE

    await dataRedis.set(cacheKey, level, 'EX', 60).catch(() => undefined)

    return level
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
