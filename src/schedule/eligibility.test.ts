import { describe, expect, test } from 'bun:test'
import { canEditSignups, canFillSlot, canSeeSlot, type Viewer } from './eligibility'
import { PERMISSION } from '../utils/globalModel'
import { PERM, permissionsForLevel } from '../utils/permissions'
import type { Membership } from '../utils/membershipRule'

/**
 * Who may fill a sign-up slot.
 *
 * Pinned because this rule replaced a rank threshold that lived in two places
 * and disagreed with itself (§5, §6.1), and because the empty list means the
 * opposite of what an empty list usually does — a change of mind here silently
 * opens or closes every sheet on the instance.
 */

const DRIVER = 'rank-driver'
const DISPATCHER = 'rank-dispatcher'

function viewer(permissions: number, rankId: string | null, elevated = false): Viewer {
    const membership: Membership = {
        permissionLevel: PERMISSION.NONE,
        robloxRank: rankId === null ? -1 : 10,
        permissions,
        rankId
    }

    return { membership, elevated }
}

const stranger: Viewer = viewer(0, null)
const driver = viewer(0, DRIVER)

describe('canFillSlot', () => {
    test('a rank on the list may fill the slot', () => {
        expect(canFillSlot([DRIVER, DISPATCHER], driver)).toBe(true)
    })

    test('a rank that is not on the list may not', () => {
        // The whole point of the change: this used to be "at or above", so a
        // driver could reach a dispatcher sheet by being promoted past it.
        expect(canFillSlot([DISPATCHER], driver)).toBe(false)
    })

    test('an empty list is every member of the group', () => {
        expect(canFillSlot([], driver)).toBe(true)
    })

    test('an empty list is still not every stranger', () => {
        // Membership is the floor under all of this. "Everyone" means everyone
        // in the group, not everyone with the link.
        expect(canFillSlot([], stranger)).toBe(false)
    })

    test('a non-member holding nothing is refused a slot listed for a rank', () => {
        expect(canFillSlot([DRIVER], stranger)).toBe(false)
    })

    test('the override grant reaches any slot', () => {
        expect(canFillSlot([DISPATCHER], viewer(PERM.OVERRIDE_SIGNUPS, DRIVER))).toBe(true)
    })

    test('whoever builds the sheets can fill them', () => {
        expect(canFillSlot([DISPATCHER], viewer(PERM.MANAGE_SIGNUPS, DRIVER))).toBe(true)
    })

    test('a host keeps the reach they had before sheets were lists', () => {
        // Sheet visibility answered yes to MANAGE_SHIFTS outright, so the
        // preset carries OVERRIDE_SIGNUPS and this must stay true.
        expect(canFillSlot([DISPATCHER], viewer(permissionsForLevel(PERMISSION.HOST), DRIVER))).toBe(true)
    })

    test('an elevated site admin reaches everything', () => {
        expect(canFillSlot([DISPATCHER], viewer(0, null, true))).toBe(true)
    })

    test('editing sign-ups is not permission to take one', () => {
        // The grant moves other people's rows; it is not a way past the list.
        expect(canFillSlot([DISPATCHER], viewer(PERM.EDIT_SIGNUPS, DRIVER))).toBe(false)
    })
})

describe('canSeeSlot', () => {
    test('a slot you cannot fill is not sent to you', () => {
        // The posture sheets already had: a driver never learns the dispatcher
        // slot exists, because the API never sends it.
        expect(canSeeSlot([DISPATCHER], driver)).toBe(false)
    })

    test('somebody who moves people between slots sees the slots', () => {
        expect(canSeeSlot([DISPATCHER], viewer(PERM.EDIT_SIGNUPS, DRIVER))).toBe(true)
    })

    test('a stranger sees nothing, whatever the list says', () => {
        expect(canSeeSlot([], stranger)).toBe(false)
        expect(canSeeSlot([DRIVER], stranger)).toBe(false)
    })
})

describe('canEditSignups', () => {
    test('the grant, and the one that implies it', () => {
        expect(canEditSignups(viewer(PERM.EDIT_SIGNUPS, DRIVER))).toBe(true)
        expect(canEditSignups(viewer(PERM.MANAGE_SIGNUPS, DRIVER))).toBe(true)
    })

    test('overriding the rank list is not moderating other people', () => {
        expect(canEditSignups(viewer(PERM.OVERRIDE_SIGNUPS, DRIVER))).toBe(false)
    })

    test('an ordinary member cannot', () => {
        expect(canEditSignups(driver)).toBe(false)
    })
})
