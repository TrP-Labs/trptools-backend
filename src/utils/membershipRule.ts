import { PERMISSION } from './globalModel'
import { ALL_PERMISSIONS, levelForPermissions } from './permissions'

/**
 * What a Roblox role grants in a group.
 *
 * Split out from `groupPermission.ts` for the reason `assign.ts` is split from
 * `solver.ts` (§7): that file imports `db`, which imports `env.ts`, which
 * exits when the environment is not set — so nothing importing it can be
 * tested in CI. This imports two pure modules and nothing else.
 *
 * It also stopped being one rule in one place. `Group_.getMemberGroups` has to
 * answer the same question in bulk, over a join rather than a lookup, and a
 * second copy of the owner pin is exactly the kind of thing that drifts —
 * which is what §5 is about.
 */
export type Membership = {
    permissionLevel: number
    robloxRank: number
    /** The rank's granular grants. See `utils/permissions`. */
    permissions: number
}

export const NON_MEMBER: Membership = { permissionLevel: PERMISSION.NONE, robloxRank: -1, permissions: 0 }

/**
 * What a site admin running with admin mode on holds in every group (§5.1).
 *
 * Named here rather than written out wherever the bypass applies, because a
 * bypass that reports a *different* shape from the one `GetMembership` returns
 * is how the `canDispatch` and `getGroup` misses happened.
 */
export const ELEVATED: Membership = {
    permissionLevel: PERMISSION.MANAGE,
    robloxRank: 255,
    permissions: ALL_PERMISSIONS
}

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
 *
 * The level is *derived* from the grants rather than read from the row beside
 * them. The column is written from the same rule on every save, but deriving
 * it here means a row that somehow disagrees — a hand-edited database, a
 * half-applied migration — cannot hand somebody a level their grants do not
 * back.
 */
export function resolveMembership(
    relation: { permissions: number; cachedRank: number } | undefined,
    reportedRank: number | undefined
): Membership {
    const robloxRank = relation?.cachedRank ?? reportedRank ?? -1

    const permissions = robloxRank >= 255 ? ALL_PERMISSIONS : (relation?.permissions ?? 0)

    return { permissionLevel: levelForPermissions(permissions), robloxRank, permissions }
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
