import type { ModerationStatus } from '../db/schema'

/**
 * Content is withheld from the public while a report is outstanding.
 *
 * `APPROVED` means a site admin has looked and cleared it, so later reports
 * still get filed but no longer hide it. Without that, one persistent reporter
 * could keep a legitimate group's page suppressed indefinitely.
 */
export function isPubliclyVisible(moderation: ModerationStatus): boolean {
    return moderation !== 'HIDDEN'
}

/** What a new report should set the target's moderation to. */
export function moderationAfterReport(current: ModerationStatus): ModerationStatus {
    return current === 'APPROVED' ? 'APPROVED' : 'HIDDEN'
}

/**
 * People who can see hidden content: the group's own staff, and site admins.
 *
 * It is handed the answer to "is this caller an elevated site admin"
 * (`isSiteAdmin`) rather than a rank string: an admin only counts while admin
 * mode is on, which is not a fact a bare `siteRank` carries.
 */
export function canSeeHidden(siteAdmin: boolean, permissionLevel: number): boolean {
    return siteAdmin || permissionLevel >= 1
}

/** The suspension fields carried on a user row. */
export interface BanState {
    bannedAt: Date | null
    banExpiresAt: Date | null
}

/**
 * Whether an account is suspended *right now*.
 *
 * A temporary suspension lapses on its own rather than being cleared by a job,
 * so nothing may read `bannedAt` on its own — every place that grants access
 * asks this instead. Keeping the lapsed row also leaves an admin something to
 * look at when the same account comes up again.
 */
export function isBanned(state: BanState, now: number = Date.now()): boolean {
    if (!state.bannedAt) return false
    return !state.banExpiresAt || state.banExpiresAt.getTime() > now
}
