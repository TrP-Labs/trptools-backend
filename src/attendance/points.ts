/**
 * How attendance turns into points, and points into a promotion or demotion.
 *
 * Imports nothing that reads the environment, so `points.test.ts` can pin the
 * rules without a database — the same split as `assign.ts` (§7).
 */

export type RankRules = {
    id: string
    minPoints: number | null
    maxPoints: number | null
    /** Share of a shift, in percent, somebody must be on the server for it to count. */
    requiredPercent: number
    unsignedPoints: number
    promotionRankId: string | null
    demotionRankId: string | null
    /** Slot id → points; a slot with no entry is worth one. */
    slotPoints: Map<string, number>
}

export type ShiftWindow = {
    id: string
    start: number
    end: number
    /**
     * Whether a game server reported anything for this occurrence. A shift
     * nobody tracked cannot say who turned up, so a sign-up is taken at its
     * word there rather than every sign-up quietly counting as a no-show.
     */
    tracked: boolean
}

export type Activity = { seconds?: number; slotId?: string }

export const DEFAULT_SLOT_POINTS = 1

export function presentPercent(seconds: number, start: number, end: number): number {
    const length = (end - start) / 1000
    if (length <= 0) return 0
    return Math.min(100, (seconds / length) * 100)
}

/**
 * What one shift is worth to one person.
 *
 * Signing up and simply turning up are mutually exclusive, never added: a
 * slot worth one point is worth one point, even when being on the server for
 * the shift would on its own have been worth half. Either way the time on the
 * server has to reach the rank's threshold — a sign-up is a promise to turn
 * up, not the turning up — except on a shift nobody was tracking.
 */
export function shiftPoints(rules: RankRules, shift: ShiftWindow, activity: Activity): number {
    const present = presentPercent(activity.seconds ?? 0, shift.start, shift.end) >= rules.requiredPercent
    if (activity.slotId) {
        return present || !shift.tracked ? rules.slotPoints.get(activity.slotId) ?? DEFAULT_SLOT_POINTS : 0
    }
    return present ? rules.unsignedPoints : 0
}

export function totalPoints(rules: RankRules, shifts: ShiftWindow[], activity: Map<string, Activity>) {
    let points = 0
    let counted = 0
    for (const shift of shifts) {
        const earned = shiftPoints(rules, shift, activity.get(shift.id) ?? {})
        if (earned > 0) counted++
        points += earned
    }
    // Points are often halves; keep the sum free of floating-point dust.
    return { points: Math.round(points * 100) / 100, counted }
}

export type Verdict = 'PROMOTE' | 'DEMOTE' | null

/**
 * Over the maximum is a promotion, under the minimum a demotion — strictly,
 * so a maximum of four is met, not exceeded, by four. Either needs a rank to
 * go to; a bound with nowhere to send anybody is a target, not a decision.
 */
export function verdictFor(rules: RankRules, points: number): Verdict {
    if (rules.maxPoints !== null && rules.promotionRankId && points > rules.maxPoints) return 'PROMOTE'
    if (rules.minPoints !== null && rules.demotionRankId && points < rules.minPoints) return 'DEMOTE'
    return null
}

/** The calendar month `YYYY-MM`, in UTC, as a half-open range. */
export function monthRange(month: string): { from: Date; to: Date } | null {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
    if (!match) return null
    const year = Number(match[1])
    const index = Number(match[2]) - 1
    return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)) }
}

export function monthOf(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}
