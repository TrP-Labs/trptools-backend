import { has, PERM } from '../utils/permissions'
import type { Membership } from '../utils/membershipRule'
import { isGroupMember } from '../utils/membershipRule'

/**
 * Who may fill a sign-up slot, and who may merely see it.
 *
 * Sheets used to be gated on a threshold — the rank they hung off and every
 * rank above it — which is why this was three lines inside `sheets.ts`. A slot
 * now names the ranks it is for, and three grants bend the rule, so it is its
 * own file for the reason `membershipRule.ts` is: it imports two pure modules
 * and nothing that reads the environment, so it can be tested.
 *
 * §5 records what the split is worth. The threshold rule was written twice —
 * once where sheets were listed and once where a sign-up was taken — and the
 * two disagreed about who a manager was, so a driver could be shown a sheet
 * and then refused the slot on it.
 */

/** What a viewer brings to the question, once membership has been resolved. */
export type Viewer = {
    membership: Membership
    /** A site admin running with admin mode on (§5.1). */
    elevated: boolean
}

/**
 * Whether this viewer may take a slot.
 *
 * An **empty rank list means every member of the group**. A sheet starts with
 * no ranks on it, and reading that as "nobody" would make a newly built sheet
 * look finished and quietly refuse everyone; a group that simply wants open
 * sign-ups would otherwise have to list every rank it has bound and remember
 * the list again on every new binding. The sheet editor says which of the two
 * a list currently means, so it is never something to discover from a refusal.
 *
 * `OVERRIDE_SIGNUPS` is the escape hatch for whoever is actually running the
 * shift: a manager standing in for an absent dispatcher is not a reason to
 * edit the sheet. `MANAGE_SIGNUPS` carries it because somebody building the
 * sheets has to be able to fill one to see what they built.
 */
export function canFillSlot(allowedRanks: readonly string[], viewer: Viewer): boolean {
    if (viewer.elevated) return true

    // Signing up is a member action before it is a rank one. A grant cannot
    // stand in for it: permission comes from a rank, so anybody holding one is
    // in the group anyway, and elevation is handled above.
    if (!isGroupMember(viewer.membership)) return false

    const { permissions, rankId } = viewer.membership
    if (has(permissions, PERM.OVERRIDE_SIGNUPS) || has(permissions, PERM.MANAGE_SIGNUPS)) return true

    if (allowedRanks.length === 0) return true

    return rankId !== null && allowedRanks.includes(rankId)
}

/**
 * Whether this viewer may see a slot at all.
 *
 * Wider than filling it by exactly one grant. Somebody who moves people
 * between slots has to be able to read the slots they are moving them to, and
 * a page that hid half of them would make the feature look broken.
 *
 * Everyone else sees only what they can fill. That is deliberate and it is the
 * posture sheets already had: a driver never learned the dispatcher sheet
 * existed, because the API never sent it. Showing an unusable slot would
 * publish the group's staffing structure to every member for no gain.
 */
export function canSeeSlot(allowedRanks: readonly string[], viewer: Viewer): boolean {
    if (canFillSlot(allowedRanks, viewer)) return true
    return isGroupMember(viewer.membership) && has(viewer.membership.permissions, PERM.EDIT_SIGNUPS)
}

/** Whether this viewer may move or remove somebody else's sign-up. */
export function canEditSignups(viewer: Viewer): boolean {
    if (viewer.elevated) return true
    return has(viewer.membership.permissions, PERM.EDIT_SIGNUPS) || has(viewer.membership.permissions, PERM.MANAGE_SIGNUPS)
}
