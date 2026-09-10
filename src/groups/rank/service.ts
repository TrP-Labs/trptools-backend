import { status } from 'elysia'
import { and, asc, desc, eq } from 'drizzle-orm'
import db from '../../db'
import { rankRelations } from '../../db/schema'
import { globalModel, PERMISSION } from '../../utils/globalModel'
import UserHasRank, {
    assertGroupPermission,
    GetMembership,
    invalidateGroupPermissions
} from '../../utils/groupPermission'
import {
    ALL_PERMISSIONS,
    capToOwnGrants,
    levelForPermissions,
    normalise,
    permissionsForLevel,
    PERM
} from '../../utils/permissions'
import { Roblox } from '../../utils/roblox'
import { resolveCredentials } from '../../utils/robloxCredentials'
import { isSiteAdmin, type session } from '../../utils/sessionVerifier'
import { findGroup, recordAudit } from '../service'
import { GroupModel } from '../model'
import { RankModel } from './model'

/**
 * What the person doing the editing holds, for the escalation check below.
 *
 * A site admin operating the instance (§5.1) is not bounded by a rank, so they
 * hold everything.
 */
async function editorGrants(session: session, groupId: string): Promise<number> {
    if (isSiteAdmin(session)) return ALL_PERMISSIONS
    if (!session.user) return 0

    return (await GetMembership(session.user.userId, groupId)).permissions
}

export abstract class Rank {
    static async getAllRanks(groupId: string, session: session): Promise<RankModel.rankListResponse> {
        await assertGroupPermission(session, groupId, PERM.MANAGE_RANKS)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const ranks = await db
            .select()
            .from(rankRelations)
            .where(eq(rankRelations.groupId, group.id))
            .orderBy(asc(rankRelations.cachedRank))

        // The Roblox owner role holds manage whatever the row says, so a row
        // that disagrees is repaired here rather than left to show the wrong
        // level forever. Editing rank 255 deliberately drops any permission
        // change, so this is the only place such a row can be corrected.
        const drifted = ranks.filter(
            (rank) =>
                rank.cachedRank >= 255 &&
                (rank.permissionLevel !== PERMISSION.MANAGE || rank.permissions !== ALL_PERMISSIONS)
        )

        for (const rank of drifted) {
            await db
                .update(rankRelations)
                .set({ permissionLevel: PERMISSION.MANAGE, permissions: ALL_PERMISSIONS })
                .where(eq(rankRelations.id, rank.id))
            rank.permissionLevel = PERMISSION.MANAGE
            rank.permissions = ALL_PERMISSIONS
        }

        if (drifted.length > 0) await invalidateGroupPermissions(group.id)

        return ranks
    }

    static async getRank(rankId: string, session: session): Promise<RankModel.rankItemResponse> {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertGroupPermission(session, rank.groupId, PERM.MANAGE_RANKS)

        return rank
    }

    static async bindRank(
        groupId: string,
        robloxRoleId: string,
        session: session
    ): Promise<RankModel.createRankResponse> {
        await assertGroupPermission(session, groupId, PERM.MANAGE_RANKS)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const existing = await db
            .select({ id: rankRelations.id })
            .from(rankRelations)
            .where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.robloxId, robloxRoleId)))
            .limit(1)

        if (existing.length > 0) throw status(409, 'rank already exists' satisfies RankModel.rankExists)

        const credentials = await resolveCredentials(group.id, session.user?.userId)
        const role = await Roblox.getRoleById(group.robloxId, robloxRoleId, credentials)
        if (!role) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        const [rank] = await db
            .insert(rankRelations)
            .values({
                groupId: group.id,
                robloxId: role.id,
                cachedName: role.name,
                cachedRank: role.rank,
                color: '#9b59b6',
                visible: false,
                permissionLevel: PERMISSION.NONE,
                permissions: 0
            })
            .returning({ id: rankRelations.id })

        if (!rank) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        await invalidateGroupPermissions(group.id)
        await recordAudit(group.id, session.user?.userId ?? null, 'rank.bind', `Bound rank ${role.name}`)

        return { id: rank.id }
    }

    static async editRank(rankId: string, modification: RankModel.editRankBody, session: session) {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertGroupPermission(session, rank.groupId, PERM.MANAGE_RANKS)

        const { refresh, permissionLevel, permissions, ...patch } = modification

        const update: Record<string, unknown> = { ...patch }

        // The Roblox owner role always keeps full control. Without this, an
        // administrator could demote the owner and lock everyone out — and
        // §5 records what that costs: the row could then only be repaired by
        // a site admin, because the one edit that would fix it is dropped.
        if (rank.cachedRank !== 255) {
            // A preset replaces the grants wholesale; the granular list sends
            // the grants themselves. Both write both columns, so the level and
            // the bits beside it can never disagree about what a rank is.
            const next =
                permissions !== undefined
                    ? normalise(permissions)
                    : permissionLevel !== undefined
                      ? permissionsForLevel(permissionLevel)
                      : undefined

            if (next !== undefined) {
                const editor = await editorGrants(session, rank.groupId)
                const granted = capToOwnGrants(next, rank.permissions, editor)

                update.permissions = granted
                update.permissionLevel = levelForPermissions(granted)
            }
        }

        if (refresh) {
            const group = await findGroup(rank.groupId)
            if (group) {
                const credentials = await resolveCredentials(group.id, session.user?.userId)
                const role = await Roblox.getRoleById(group.robloxId, rank.robloxId, credentials)
                if (role) {
                    update.cachedName = role.name
                    update.cachedRank = role.rank
                }
            }
        }

        if (Object.keys(update).length > 0) {
            await db.update(rankRelations).set(update).where(eq(rankRelations.id, rankId))
        }

        await invalidateGroupPermissions(rank.groupId)
        await recordAudit(rank.groupId, session.user?.userId ?? null, 'rank.update', `Updated rank ${rank.cachedName}`)

        return 'Success' as globalModel.genericSuccess
    }

    static async unbindRank(rankId: string, session: session) {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertGroupPermission(session, rank.groupId, PERM.MANAGE_RANKS)

        if (rank.cachedRank === 255) throw status(403, 'Forbidden' satisfies globalModel.forbidden)

        await db.delete(rankRelations).where(eq(rankRelations.id, rankId))

        await invalidateGroupPermissions(rank.groupId)
        await recordAudit(rank.groupId, session.user?.userId ?? null, 'rank.unbind', `Unbound rank ${rank.cachedName}`)

        return 'Success' as globalModel.genericSuccess
    }

    /**
     * The public roster: who holds each rank a group has chosen to show.
     *
     * This is what "show on public roster" controls. Ranks are ordered highest
     * first, and members are capped so a group with thousands of members does
     * not produce an enormous response.
     */
    static async getRoster(groupIdOrSlug: string, session: session): Promise<RankModel.rosterResponse> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const isStaff =
            isSiteAdmin(session) ||
            (session.user ? await UserHasRank(session.user.userId, group.id, PERMISSION.DISPATCH) : false)

        if (!isStaff && (group.visibility === 'PRIVATE' || !group.showRoster || group.moderation === 'HIDDEN')) {
            throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)
        }

        const visible = await db
            .select()
            .from(rankRelations)
            .where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.visible, true)))
            .orderBy(desc(rankRelations.cachedRank))

        if (visible.length === 0) return []

        const rosters = await Promise.all(
            visible.map(async (rank) => {
                const { total, members } = await Roblox.getRoleMembers(group.robloxId, rank.robloxId)
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

        return rosters
    }

    /** Roblox roles in the group that are not bound on TrPTools yet. */
    static async getUnassignedRanks(groupId: string, session: session): Promise<RankModel.availableRanksResponse> {
        await assertGroupPermission(session, groupId, PERM.MANAGE_RANKS)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const credentials = await resolveCredentials(group.id, session.user?.userId)
        const [roles, bound] = await Promise.all([
            Roblox.getRoles(group.robloxId, credentials),
            db.select({ robloxId: rankRelations.robloxId }).from(rankRelations).where(eq(rankRelations.groupId, group.id))
        ])

        const taken = new Set(bound.map((row) => row.robloxId))

        return roles
            .filter((role) => !taken.has(role.id))
            .sort((a, b) => b.rank - a.rank)
            .map((role) => ({ robloxId: role.id, name: role.name, rank: role.rank }))
    }
}
