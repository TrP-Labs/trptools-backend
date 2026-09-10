import { PERMISSION } from './globalModel'

/**
 * What a rank may do, one bit at a time.
 *
 * The four-level ladder (§5) said what a rank *was* rather than what it could
 * do, and every screen the dashboard grew had to be filed under one of them.
 * That put configuring the Discord bot, editing routes and renaming the group
 * behind the same grant, so a group that wanted somebody to keep the timetable
 * had to hand them the Open Cloud key as well.
 *
 * Bits rather than a join table: a rank's grants are read on nearly every
 * request, travel through the permission cache with the membership, and are
 * edited as one form. `int4` carries 31 of them, which is far more than the
 * dashboard has surfaces.
 *
 * This file imports one constant and nothing that reads the environment, so it
 * is testable — the same split as `membershipRule.ts` (§5).
 */
export const PERM = {
    /** See the group in the dashboard at all. Every grant implies it. */
    VIEW_DASHBOARD: 1 << 0,

    /** Join a dispatch room and assign routes in it. */
    DISPATCH: 1 << 1,
    /** Open and close a group's dispatch room. */
    START_ROOM: 1 << 2,

    /** Create, edit and delete shifts and their schedules. */
    MANAGE_SHIFTS: 1 << 3,
    MANAGE_ROUTES: 1 << 4,
    MANAGE_DEPOTS: 1 << 5,
    /** Bind ranks, and decide what every other rank may do. */
    MANAGE_RANKS: 1 << 6,

    /** Build application forms, open and close them. */
    MANAGE_APPLICATIONS: 1 << 7,
    /** Read the queue and approve or deny an applicant. */
    REVIEW_APPLICATIONS: 1 << 8,

    /** Connect the Discord bot and choose what it posts where. */
    MANAGE_BOT: 1 << 9,
    /** Vehicle types and the naming rules dispatch matches against. */
    MANAGE_VEHICLES: 1 << 10,
    /** The group's name, address, page copy and images. */
    MANAGE_GROUP: 1 << 11,
    /** Who can see the group and which parts of its public page show. */
    MANAGE_VISIBILITY: 1 << 12,
    /** Store and replace the group's Open Cloud API key. */
    MANAGE_OPEN_CLOUD: 1 << 13,
    /** Read the record of administrative changes. */
    VIEW_AUDIT_LOG: 1 << 14,

    /** Everything, including anything added later. */
    ADMINISTRATOR: 1 << 15,

    /**
     * Build sign-up sheets: their slots, their rank lists and where the bot
     * posts them.
     *
     * Separate from `MANAGE_SHIFTS` because they are separate jobs — one
     * decides when the service runs, the other who staffs it — and separate
     * from `MANAGE_RANKS`, which is where sheets lived while they hung off a
     * rank. Handing somebody the sheet editor should not also hand them the
     * ability to make themselves an administrator.
     */
    MANAGE_SIGNUPS: 1 << 16,

    /**
     * Take a slot whose rank list does not include this rank.
     *
     * The escape hatch for the person actually running the shift: a sheet
     * says who it is *for*, and a manager standing in for an absent
     * dispatcher is not a reason to edit the sheet. Holding this also means
     * seeing every sheet, since a slot you may fill is one you may read.
     */
    OVERRIDE_SIGNUPS: 1 << 17,

    /**
     * Move somebody else's sign-up to another slot, or take it off entirely.
     *
     * Only ever acts on rows that already exist — it does not put anybody on
     * a shift who did not put themselves there, which is a different and much
     * louder thing to be able to do to somebody's Saturday.
     */
    EDIT_SIGNUPS: 1 << 18
} as const

export type PermissionFlag = (typeof PERM)[keyof typeof PERM]

/** Every bit this build knows about, for the owner role and for validation. */
export const ALL_PERMISSIONS = Object.values(PERM).reduce((all, flag) => all | flag, 0)

/**
 * What each rung of the old ladder grants.
 *
 * These are also the presets the rank editor offers, because a group that
 * never opens the granular list should keep behaving exactly as it did.
 * Manage is `ADMINISTRATOR` rather than the union of today's bits: a group
 * that granted "manage the group" before this existed meant *everything*, and
 * would otherwise silently not include whatever is added next.
 */
export const LEVEL_PERMISSIONS: Record<number, number> = {
    [PERMISSION.NONE]: 0,
    [PERMISSION.DISPATCH]: PERM.VIEW_DASHBOARD | PERM.DISPATCH,
    // `OVERRIDE_SIGNUPS` is here because a host could already take any slot
    // in their group: sheet visibility used to answer yes to `MANAGE_SHIFTS`
    // outright. Leaving it out would make the preset quietly narrower than the
    // one it replaces.
    [PERMISSION.HOST]:
        PERM.VIEW_DASHBOARD |
        PERM.DISPATCH |
        PERM.START_ROOM |
        PERM.MANAGE_SHIFTS |
        PERM.REVIEW_APPLICATIONS |
        PERM.OVERRIDE_SIGNUPS,
    [PERMISSION.MANAGE]: ALL_PERMISSIONS
}

export function permissionsForLevel(level: number): number {
    return LEVEL_PERMISSIONS[level] ?? 0
}

/**
 * The ladder rung a set of grants sits on.
 *
 * The four levels have not gone away — they are what `rank_relations` still
 * indexes, what the group list filters on, and what a dozen callers compare —
 * so every grant maps back onto one. Anything past dispatch that is not
 * administrator reads as host: it is more than a dispatcher and less than a
 * manager, which is exactly what that rung meant.
 */
export function levelForPermissions(permissions: number): number {
    if (has(permissions, PERM.ADMINISTRATOR)) return PERMISSION.MANAGE
    if (permissions & ~(PERM.VIEW_DASHBOARD | PERM.DISPATCH)) return PERMISSION.HOST
    if (has(permissions, PERM.DISPATCH)) return PERMISSION.DISPATCH
    return permissions === 0 ? PERMISSION.NONE : PERMISSION.DISPATCH
}

/**
 * Whether a set of grants carries a flag.
 *
 * `ADMINISTRATOR` answers yes to everything, so a permission added in a later
 * release is held by the ranks that were meant to have it rather than by
 * nobody until somebody re-opens the editor.
 */
export function has(permissions: number, flag: number): boolean {
    if (permissions & PERM.ADMINISTRATOR) return true
    return (permissions & flag) === flag
}

/**
 * Cleans a set of grants coming in from a request.
 *
 * Unknown bits are dropped rather than stored: the column is an integer, so
 * without this a client could set bits this build has no name for and a later
 * release would find them already granted. Anything at all implies seeing the
 * dashboard — a rank that may edit routes but not open the group is not a
 * state the UI can express, and would read as a bug from either end.
 */
export function normalise(permissions: number): number {
    const known = permissions & ALL_PERMISSIONS
    return known === 0 ? 0 : known | PERM.VIEW_DASHBOARD
}

/**
 * Caps an edit to the grants the editor holds themselves.
 *
 * Whoever may bind ranks can edit every rank in the group, including their
 * own — so without this, "may manage ranks" would quietly be "may become an
 * administrator", and a group could not delegate the rank list at all. An
 * administrator is capped by nothing, which is what that grant means.
 *
 * Grants the target rank *already* holds are left alone rather than stripped:
 * an editor who cannot grant a permission should not be able to revoke one
 * either, and silently clearing it on an unrelated save is how a colour change
 * ends up demoting somebody.
 */
export function capToOwnGrants(wanted: number, current: number, editor: number): number {
    if (has(editor, PERM.ADMINISTRATOR)) return wanted

    const added = wanted & ~current
    const removed = current & ~wanted

    return (current | (added & editor)) & ~(removed & editor)
}
