import { eq } from 'drizzle-orm'
import db from '../db'
import { users } from '../db/schema'
import { requireUser } from '../utils/authPlugin'
import { invalidateUserPermissions } from '../utils/groupPermission'
import { dataRedis, deleteByPattern } from '../utils/redis'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { cloudFor } from './service'
import { highestRank, membershipRoles } from './roblox'

/**
 * Moves somebody else to a Roblox role through the group's write connection.
 *
 * Shared by promotions and approved applications, so both are held to the
 * same safeguards: the person must still be in the group, the role must be a
 * real non-owner role, and both the role and the person's current rank must
 * sit below the member acting *and* below whoever authorized the connection.
 * The base Member role is kept and every other role is replaced, which is
 * what Roblox's own assign/unassign operations amount to.
 */

/** Why a change was refused before Roblox was asked, for the caller to word. */
export class RankChangeRefused extends Error {
    constructor(readonly reason: 'GONE' | 'UNSAFE' | 'DISCONNECTED') {
        super(reason)
    }
}

export type RankChangeOutcome = 'CONFIRMED' | 'PENDING'

export async function changeRank(
    group: { id: string; robloxId: string },
    robloxUserId: number,
    roleId: string,
    session: session
): Promise<RankChangeOutcome> {
    const user = requireUser(session)
    // Throws its own 503 when the group has no working connection.
    const { cloud, writer } = await cloudFor(group.id)
    const roles = await cloud.roles(group.robloxId)
    const [membership, writerMembership, actorMembership] = await Promise.all([
        cloud.membership(group.robloxId, robloxUserId),
        cloud.membership(group.robloxId, writer.robloxId),
        isSiteAdmin(session) ? Promise.resolve(null) : cloud.membership(group.robloxId, user.robloxId)
    ])
    const role = roles.find((item) => item.id === roleId)
    const current = highestRank(membership, roles)
    const writerRank = highestRank(writerMembership, roles)
    const actorRank = isSiteAdmin(session) ? 255 : highestRank(actorMembership, roles)
    if (!membership || !role || role.rank < 1 || role.rank >= 255) throw new RankChangeRefused('GONE')
    if (role.rank >= actorRank || current >= actorRank) throw new RankChangeRefused('UNSAFE')
    if (role.rank >= writerRank || current >= writerRank) throw new RankChangeRefused('DISCONNECTED')

    const targetPath = `groups/${group.robloxId}/roles/${role.id}`
    const removed = membershipRoles(membership).filter((path) =>
        path !== targetPath && (roles.find((item) => path.endsWith(`/roles/${item.id}`))?.rank ?? 0) > 1)
    try {
        await cloud.change(membership, targetPath, removed)
        const after = await cloud.membership(group.robloxId, robloxUserId).catch(() => null)
        return after && membershipRoles(after).includes(targetPath) ? 'CONFIRMED' : 'PENDING'
    } finally {
        // Even a failed write may have reached Roblox; the next read must
        // resolve whatever roles are really left.
        await invalidatePerson(group.id, group.robloxId, String(robloxUserId))
    }
}

/** Forgets what was cached about somebody's rank, so every page reads the new one. */
export async function invalidatePerson(groupId: string, robloxGroupId: string, robloxId: string) {
    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.robloxId, Number(robloxId))).limit(1)
    await Promise.all([
        account ? invalidateUserPermissions(account.id) : Promise.resolve(),
        account ? dataRedis.del(`perm:last:${groupId}:${account.id}`) : Promise.resolve(0),
        dataRedis.del(`roblox:membership:${robloxGroupId}:${robloxId}`, `roblox:usergroups:${robloxId}`),
        deleteByPattern(`roblox:rolemembers:${robloxGroupId}:*`)
    ])
}
