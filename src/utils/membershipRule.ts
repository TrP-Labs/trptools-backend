import { PERMISSION } from './globalModel'

/**
 * What a Roblox role grants in a group.
 *
 * Split out from `groupPermission.ts` for the reason `assign.ts` is split from
 * `solver.ts` (§7): that file imports `db`, which imports `env.ts`, which
 * exits when the environment is not set — so nothing importing it can be
 * tested in CI. This imports one constant and nothing else.
 *
 * It also stopped being one rule in one place. `Group_.getMemberGroups` has to
 * answer the same question in bulk, over a join rather than a lookup, and a
 * second copy of the owner pin is exactly the kind of thing that drifts —
 * which is what §5 is about.
 */
export type Membership = {
    permissionLevel: number
    robloxRank: number
}

export const NON_MEMBER: Membership = { permissionLevel: PERMISSION.NONE, robloxRank: -1 }

/**
 * Resolves a role against the group's binding for it.
 *
 * `relation` is the `rank_relations` row for the role, absent when the group
 * has never bound it. `reportedRank` is what Roblox says the role's rank is,
 * which still tells us the person's standing even with no binding — so a
 * member of a group that has configured nothing is a member, not a stranger.
 *
 * The Roblox owner role always holds full control, and that is settled here
 * rather than only where ranks are edited. A group whose owner row drifted
 * below manage could not be repaired through the API at all, because editing
 * rank 255 deliberately drops any permission change.
 */
export function resolveMembership(
    relation: { permissionLevel: number; cachedRank: number } | undefined,
    reportedRank: number | undefined
): Membership {
    const robloxRank = relation?.cachedRank ?? reportedRank ?? -1

    const permissionLevel =
        robloxRank >= 255 ? PERMISSION.MANAGE : (relation?.permissionLevel ?? PERMISSION.NONE)

    return { permissionLevel, robloxRank }
}

/**
 * Whether somebody is in the group at all.
 *
 * A different question from what they may *do* there, and the one that decides
 * whether they see its shifts. `-1` is the non-member; Roblox's own ranks
 * start at 0.
 */
export function isGroupMember(membership: Membership): boolean {
    return membership.robloxRank >= 0
}
