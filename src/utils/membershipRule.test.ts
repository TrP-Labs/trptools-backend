import { describe, expect, test } from 'bun:test'
import { PERMISSION } from './globalModel'
import { isGroupMember, resolveMembership } from './membershipRule'
import { ALL_PERMISSIONS, PERM, permissionsForLevel } from './permissions'

/**
 * The rule deciding what a Roblox role is worth in a group.
 *
 * Pinned because §5 records two bugs that came from exactly these lines being
 * written twice and drifting: an owner whose row had fallen below manage could
 * not repair it through the API, and a member with no permission was treated
 * as not being in the group at all.
 */

describe('resolveMembership', () => {
    test('an unbound role still reports the rank Roblox gave it', () => {
        expect(resolveMembership(undefined, 10)).toEqual({
            permissionLevel: PERMISSION.NONE,
            robloxRank: 10,
            permissions: 0
        })
    })

    test('a bound role grants what the group bound it to', () => {
        const permissions = permissionsForLevel(PERMISSION.DISPATCH)

        expect(resolveMembership({ permissions, cachedRank: 50 }, 50)).toEqual({
            permissionLevel: PERMISSION.DISPATCH,
            robloxRank: 50,
            permissions
        })
    })

    test('the owner role holds full control however the row was left', () => {
        // The drift §5 is about: a row bound before the rule existed.
        expect(resolveMembership({ permissions: 0, cachedRank: 255 }, 255)).toEqual({
            permissionLevel: PERMISSION.MANAGE,
            robloxRank: 255,
            permissions: ALL_PERMISSIONS
        })
    })

    test('an owner whose role the group never bound is still the owner', () => {
        expect(resolveMembership(undefined, 255).permissionLevel).toBe(PERMISSION.MANAGE)
    })

    test('nothing known at all is a non-member', () => {
        expect(resolveMembership(undefined, undefined)).toEqual({
            permissionLevel: PERMISSION.NONE,
            robloxRank: -1,
            permissions: 0
        })
    })

    test('the cached rank wins over what Roblox reported', () => {
        // The binding is the group's own record of the role's ordering.
        expect(resolveMembership({ permissions: 0, cachedRank: 7 }, 3).robloxRank).toBe(7)
    })

    test('a rank holding one manage grant is not a dispatcher', () => {
        // The level a set of grants lands on is what every older caller still
        // compares, so a rank that may edit depots must not read as level 1.
        const membership = resolveMembership(
            { permissions: PERM.VIEW_DASHBOARD | PERM.MANAGE_DEPOTS, cachedRank: 5 },
            5
        )

        expect(membership.permissionLevel).toBe(PERMISSION.HOST)
        expect(membership.permissions & PERM.MANAGE_DEPOTS).toBeTruthy()
    })
})

describe('isGroupMember', () => {
    test('a member with no permission is still a member', () => {
        // The shifts bug: this is the driver who was shown an empty schedule
        // for every group they actually drive for.
        expect(isGroupMember({ permissionLevel: PERMISSION.NONE, robloxRank: 0, permissions: 0 })).toBe(true)
    })

    test('a non-member is not', () => {
        expect(isGroupMember({ permissionLevel: PERMISSION.NONE, robloxRank: -1, permissions: 0 })).toBe(false)
    })
})
