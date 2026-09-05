import { describe, expect, test } from 'bun:test'
import { PERMISSION } from './globalModel'
import { isGroupMember, resolveMembership } from './membershipRule'

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
            robloxRank: 10
        })
    })

    test('a bound role grants what the group bound it to', () => {
        expect(resolveMembership({ permissionLevel: PERMISSION.DISPATCH, cachedRank: 50 }, 50)).toEqual({
            permissionLevel: PERMISSION.DISPATCH,
            robloxRank: 50
        })
    })

    test('the owner role holds full control however the row was left', () => {
        // The drift §5 is about: a row bound before the rule existed.
        expect(resolveMembership({ permissionLevel: PERMISSION.NONE, cachedRank: 255 }, 255)).toEqual({
            permissionLevel: PERMISSION.MANAGE,
            robloxRank: 255
        })
    })

    test('an owner whose role the group never bound is still the owner', () => {
        expect(resolveMembership(undefined, 255).permissionLevel).toBe(PERMISSION.MANAGE)
    })

    test('nothing known at all is a non-member', () => {
        expect(resolveMembership(undefined, undefined)).toEqual({
            permissionLevel: PERMISSION.NONE,
            robloxRank: -1
        })
    })

    test('the cached rank wins over what Roblox reported', () => {
        // The binding is the group's own record of the role's ordering.
        expect(resolveMembership({ permissionLevel: PERMISSION.NONE, cachedRank: 7 }, 3).robloxRank).toBe(7)
    })
})

describe('isGroupMember', () => {
    test('a member with no permission is still a member', () => {
        // The shifts bug: this is the driver who was shown an empty schedule
        // for every group they actually drive for.
        expect(isGroupMember({ permissionLevel: PERMISSION.NONE, robloxRank: 0 })).toBe(true)
    })

    test('a non-member is not', () => {
        expect(isGroupMember({ permissionLevel: PERMISSION.NONE, robloxRank: -1 })).toBe(false)
    })
})
