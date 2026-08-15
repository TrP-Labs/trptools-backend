import { RRule, rrulestr } from 'rrule'

/**
 * Recurrence helpers shared by the scheduler, the dispatch room gate and the
 * public shift listings.
 *
 * rrule works in floating UTC, so every date crossing this boundary is a real
 * UTC instant and formatting into a local timezone is the frontend's job.
 */

export function parseRule(rule: string, dtstart: Date): RRule | null {
    try {
        const parsed = rrulestr(rule, { dtstart, forceset: false })
        // rrulestr can hand back an RRuleSet; both expose the methods we use.
        return parsed as RRule
    } catch {
        return null
    }
}

export function isValidRule(rule: string): boolean {
    return parseRule(rule, new Date()) !== null
}

export interface Occurrence {
    start: Date
    end: Date
}

/** Occurrences that start inside [from, to]. */
export function occurrencesBetween(
    rule: string,
    dtstart: Date,
    durationMinutes: number,
    from: Date,
    to: Date,
    limit = 50
): Occurrence[] {
    const parsed = parseRule(rule, dtstart)
    if (!parsed) return []

    try {
        return parsed
            .between(from, to, true)
            .slice(0, limit)
            .map((start) => ({ start, end: new Date(start.getTime() + durationMinutes * 60_000) }))
    } catch {
        return []
    }
}

/** The next `count` occurrences at or after `from`. */
export function upcomingOccurrences(
    rule: string,
    dtstart: Date,
    durationMinutes: number,
    from: Date,
    count: number
): Occurrence[] {
    const parsed = parseRule(rule, dtstart)
    if (!parsed) return []

    try {
        const results: Occurrence[] = []

        parsed.all((date, index) => {
            if (index > 2000) return false
            if (date.getTime() >= from.getTime()) {
                results.push({ start: date, end: new Date(date.getTime() + durationMinutes * 60_000) })
            }
            return results.length < count
        })

        return results
    } catch {
        return []
    }
}

/**
 * The occurrence happening right now, if there is one.
 *
 * A shift counts as live from `start` until `start + duration`, and may be
 * opened up to `graceMinutes` early so a host can set up ahead of time.
 */
export function activeOccurrence(
    rule: string,
    dtstart: Date,
    durationMinutes: number,
    graceMinutes = 30,
    now = new Date()
): Occurrence | null {
    const parsed = parseRule(rule, dtstart)
    if (!parsed) return null

    try {
        const window = Math.max(durationMinutes, 1) * 60_000
        const candidates = parsed.between(
            new Date(now.getTime() - window),
            new Date(now.getTime() + graceMinutes * 60_000),
            true
        )

        for (const start of candidates.reverse()) {
            const end = new Date(start.getTime() + durationMinutes * 60_000)
            const opensAt = start.getTime() - graceMinutes * 60_000

            if (now.getTime() >= opensAt && now.getTime() < end.getTime()) {
                return { start, end }
            }
        }

        return null
    } catch {
        return null
    }
}

/** A human summary such as "every week on Monday". */
export function describeRule(rule: string, dtstart: Date): string {
    const parsed = parseRule(rule, dtstart)
    if (!parsed) return 'Invalid recurrence'

    try {
        return parsed.toText()
    } catch {
        return 'Custom recurrence'
    }
}
