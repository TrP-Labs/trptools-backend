import { describe, expect, test } from 'bun:test'
import { PERMISSION } from './globalModel'
import {
    ALL_PERMISSIONS,
    capToOwnGrants,
    has,
    levelForPermissions,
    normalise,
    PERM,
    permissionsForLevel
} from './permissions'

/**
 * The grants themselves.
 *
 * Pinned separately from `membershipRule` because these are the numbers stored
 * in the database: a bit that changes meaning silently re-grants whatever it
 * used to mean to every rank already holding it.
 */

describe('has', () => {
    test('administrator answers yes to everything', () => {
        // Including a permission that does not exist yet, which is the whole
        // reason "manage" maps to this bit rather than to today's union.
        expect(has(PERM.ADMINISTRATOR, PERM.MANAGE_BOT)).toBe(true)
        expect(has(PERM.ADMINISTRATOR, 1 << 30)).toBe(true)
    })

    test('a grant it does not hold is refused', () => {
        expect(has(PERM.MANAGE_ROUTES, PERM.MANAGE_DEPOTS)).toBe(false)
    })

    test('holding nothing refuses everything', () => {
        expect(has(0, PERM.VIEW_DASHBOARD)).toBe(false)
    })
})

describe('presets', () => {
    test('the old levels grant what they always did', () => {
        expect(has(permissionsForLevel(PERMISSION.DISPATCH), PERM.DISPATCH)).toBe(true)
        expect(has(permissionsForLevel(PERMISSION.DISPATCH), PERM.START_ROOM)).toBe(false)

        expect(has(permissionsForLevel(PERMISSION.HOST), PERM.START_ROOM)).toBe(true)
        expect(has(permissionsForLevel(PERMISSION.HOST), PERM.MANAGE_ROUTES)).toBe(false)

        expect(permissionsForLevel(PERMISSION.MANAGE)).toBe(ALL_PERMISSIONS)
        expect(permissionsForLevel(PERMISSION.NONE)).toBe(0)
    })

    test('every preset round-trips to the level it came from', () => {
        for (const level of [PERMISSION.NONE, PERMISSION.DISPATCH, PERMISSION.HOST, PERMISSION.MANAGE]) {
            expect(levelForPermissions(permissionsForLevel(level))).toBe(level)
        }
    })
})

describe('levelForPermissions', () => {
    test('a manage grant on its own does not read as manage', () => {
        // Otherwise a rank allowed to keep the timetable would pass every
        // older `assertPermission(MANAGE)` check in the codebase.
        expect(levelForPermissions(PERM.VIEW_DASHBOARD | PERM.MANAGE_SHIFTS)).toBe(PERMISSION.HOST)
    })

    test('seeing the dashboard is enough to be listed in one', () => {
        expect(levelForPermissions(PERM.VIEW_DASHBOARD)).toBe(PERMISSION.DISPATCH)
    })
})

describe('normalise', () => {
    test('drops bits this build has no name for', () => {
        expect(normalise(PERM.MANAGE_ROUTES | (1 << 30))).toBe(PERM.MANAGE_ROUTES | PERM.VIEW_DASHBOARD)
    })

    test('any grant implies seeing the group', () => {
        expect(has(normalise(PERM.MANAGE_BOT), PERM.VIEW_DASHBOARD)).toBe(true)
    })

    test('nothing stays nothing', () => {
        expect(normalise(0)).toBe(0)
    })
})

describe('capToOwnGrants', () => {
    const editor = PERM.VIEW_DASHBOARD | PERM.MANAGE_RANKS | PERM.MANAGE_DEPOTS

    test('a grant the editor holds goes through', () => {
        expect(capToOwnGrants(PERM.MANAGE_DEPOTS, 0, editor) & PERM.MANAGE_DEPOTS).toBeTruthy()
    })

    test('a grant the editor does not hold is dropped', () => {
        // The escalation this exists to stop: whoever may edit ranks may edit
        // their own, so without the cap that grant would be every grant.
        const result = capToOwnGrants(PERM.ADMINISTRATOR | PERM.MANAGE_BOT, 0, editor)

        expect(result & PERM.ADMINISTRATOR).toBe(0)
        expect(result & PERM.MANAGE_BOT).toBe(0)
    })

    test('a grant the target already holds survives an unrelated save', () => {
        // A colour change sends the grants back unchanged; an editor who
        // cannot see past their own must not strip what is already there.
        const current = PERM.VIEW_DASHBOARD | PERM.MANAGE_BOT
        expect(capToOwnGrants(current, current, editor)).toBe(current)
    })

    test('an editor cannot revoke what they could not have granted', () => {
        const current = PERM.VIEW_DASHBOARD | PERM.MANAGE_BOT
        const wanted = PERM.VIEW_DASHBOARD

        expect(capToOwnGrants(wanted, current, editor) & PERM.MANAGE_BOT).toBeTruthy()
    })

    test('an editor can revoke what they hold', () => {
        const current = PERM.VIEW_DASHBOARD | PERM.MANAGE_DEPOTS
        const wanted = PERM.VIEW_DASHBOARD

        expect(capToOwnGrants(wanted, current, editor) & PERM.MANAGE_DEPOTS).toBe(0)
    })

    test('an administrator is capped by nothing', () => {
        expect(capToOwnGrants(ALL_PERMISSIONS, 0, PERM.ADMINISTRATOR)).toBe(ALL_PERMISSIONS)
    })
})
