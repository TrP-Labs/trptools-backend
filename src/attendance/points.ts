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
    /**
     * Taken off for a slot somebody signed up for and then did not turn up
     * to, on a shift a server tracked. Zero switches it off.
     */
    noShowPoints: number
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

export type Activity = { seconds?: number; slotId?: string; jobs?: string[] }

export const DEFAULT_SLOT_POINTS = 1

export function presentPercent(seconds: number, start: number, end: number): number {
    const length = (end - start) / 1000
    if (length <= 0) return 0
    return Math.min(100, (seconds / length) * 100)
}

/**
 * Why a shift is worth what it is, so the activity sheet can say so.
 *
 * `SIGNED_UP` and `PRESENT` earned something; `NO_SHOW` is a slot left empty
 * on a tracked shift, worth the rank's penalty when it has one; `SHORT` is
 * time on the server below the threshold; `TAKEN_AT_WORD` is a sign-up on a
 * shift nobody tracked.
 */
export type ShiftReason = 'SIGNED_UP' | 'TAKEN_AT_WORD' | 'PRESENT' | 'NO_SHOW' | 'SHORT' | 'ABSENT'

export type ShiftScore = { points: number; reason: ShiftReason; percent: number | null }

/**
 * What one shift is worth to one person.
 *
 * Signing up and simply turning up are mutually exclusive, never added: a
 * slot worth one point is worth one point, even when being on the server for
 * the shift would on its own have been worth half. Either way the time on the
 * server has to reach the rank's threshold — a sign-up is a promise to turn
 * up, not the turning up — except on a shift nobody was tracking, which
 * cannot say who turned up and so can never cost anybody the penalty.
 */
export function scoreShift(rules: RankRules, shift: ShiftWindow, activity: Activity): ShiftScore {
    const percent = shift.tracked ? presentPercent(activity.seconds ?? 0, shift.start, shift.end) : null
    const present = percent !== null && percent >= rules.requiredPercent
    if (activity.slotId) {
        const worth = rules.slotPoints.get(activity.slotId) ?? DEFAULT_SLOT_POINTS
        if (!shift.tracked) return { points: worth, reason: 'TAKEN_AT_WORD', percent }
        return present ? { points: worth, reason: 'SIGNED_UP', percent } : { points: rules.noShowPoints ? -rules.noShowPoints : 0, reason: 'NO_SHOW', percent }
    }
    if (present) return { points: rules.unsignedPoints, reason: 'PRESENT', percent }
    return { points: 0, reason: activity.seconds ? 'SHORT' : 'ABSENT', percent }
}

export function shiftPoints(rules: RankRules, shift: ShiftWindow, activity: Activity): number {
    return scoreShift(rules, shift, activity).points
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
    return { points: round(points), counted }
}

export function round(points: number) {
    return Math.round(points * 100) / 100
}

export type Verdict = 'PROMOTE' | 'DEMOTE' | null

/**
 * Over the maximum is a promotion, under the minimum a demotion — strictly,
 * so a maximum of four is met, not exceeded, by four. Either needs a rank to
 * go to; a bound with nowhere to send anybody is a target, not a decision.
 *
 * The bounds are monthly, so a quarter holds somebody to three months of
 * them: a rank that asks for four points a month asks twelve of a quarter.
 */
export function verdictFor(rules: RankRules, points: number, months = 1): Verdict {
    const { minPoints, maxPoints } = boundsFor(rules, months)
    if (maxPoints !== null && rules.promotionRankId && points > maxPoints) return 'PROMOTE'
    if (minPoints !== null && rules.demotionRankId && points < minPoints) return 'DEMOTE'
    return null
}

export function boundsFor(rules: Pick<RankRules, 'minPoints' | 'maxPoints'>, months: number) {
    return {
        minPoints: rules.minPoints === null ? null : round(rules.minPoints * months),
        maxPoints: rules.maxPoints === null ? null : round(rules.maxPoints * months)
    }
}

export function monthOf(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export type PeriodKind = 'MONTH' | 'QUARTER'

export const PERIOD_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'

/**
 * A month (`2026-10`) or a calendar quarter (`2026-Q4`), in UTC, as a
 * half-open range with the number of months it spans.
 */
export function periodRange(period: string): { from: Date; to: Date; months: number; kind: PeriodKind } | null {
    const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
    if (month) {
        const year = Number(month[1])
        const index = Number(month[2]) - 1
        return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)), months: 1, kind: 'MONTH' }
    }
    const quarter = /^(\d{4})-Q([1-4])$/.exec(period)
    if (!quarter) return null
    const year = Number(quarter[1])
    const index = (Number(quarter[2]) - 1) * 3
    return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 3, 1)), months: 3, kind: 'QUARTER' }
}

export function periodOf(date: Date, kind: PeriodKind): string {
    if (kind === 'MONTH') return monthOf(date)
    return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`
}
