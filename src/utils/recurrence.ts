import { Frequency, RRule, rrulestr } from 'rrule'

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

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/**
 * The editor writes simple calendar rules with no count or end date. Jumping
 * straight to the requested day/week/month avoids replaying every occurrence
 * since the first shift, which otherwise makes a long-running daily shift
 * slower every year. Custom RRULE features still use the library below.
 */
function calendarStarts(parsed: RRule, from: Date, to: Date, limit: number): Date[] | null {
    const original = parsed.origOptions
    const supported = new Set(['freq', 'dtstart', 'interval', 'byweekday'])
    if (Object.entries(original).some(([key, value]) => value !== undefined && !supported.has(key))) return null

    const { freq, interval = 1, dtstart } = original
    if (!dtstart || interval < 1 || !Number.isInteger(interval)) return null
    if (freq !== Frequency.DAILY && freq !== Frequency.WEEKLY && freq !== Frequency.MONTHLY) return null
    if (freq !== Frequency.WEEKLY && original.byweekday !== undefined) return null

    const start = new Date(dtstart)
    const startMs = start.getTime()
    const fromMs = Math.max(from.getTime(), startMs)
    const toMs = to.getTime()
    if (fromMs > toMs || limit <= 0) return []

    const result: Date[] = []
    if (freq === Frequency.DAILY) {
        const period = interval * DAY_MS
        let next = startMs + Math.max(0, Math.ceil((fromMs - startMs) / period)) * period
        while (next <= toMs && result.length < limit) {
            result.push(new Date(next))
            next += period
        }
        return result
    }

    const hourMs = ((start.getUTCHours() * 60 + start.getUTCMinutes()) * 60 + start.getUTCSeconds()) * 1000
    if (freq === Frequency.WEEKLY) {
        const days = parsed.options.byweekday ?? []
        if (days.length === 0) return null
        const weekdays = [...days].sort((a, b) => a - b)
        const monday = (date: Date) =>
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
            ((date.getUTCDay() + 6) % 7) * DAY_MS
        const anchor = monday(start)
        const firstWeek = Math.max(0, Math.floor((monday(new Date(fromMs)) - anchor) / WEEK_MS))
        let index = Math.ceil(firstWeek / interval) * interval
        while (anchor + index * WEEK_MS <= toMs && result.length < limit) {
            const week = anchor + index * WEEK_MS
            for (const day of weekdays) {
                const candidate = week + day * DAY_MS + hourMs
                if (candidate >= fromMs && candidate <= toMs) result.push(new Date(candidate))
                if (result.length >= limit) break
            }
            index += interval
        }
        return result
    }

    const anchorMonth = start.getUTCFullYear() * 12 + start.getUTCMonth()
    const fromDate = new Date(fromMs)
    const firstMonth = Math.max(0, fromDate.getUTCFullYear() * 12 + fromDate.getUTCMonth() - anchorMonth)
    let index = Math.ceil(firstMonth / interval) * interval
    while (result.length < limit) {
        const month = anchorMonth + index
        const year = Math.floor(month / 12)
        const monthOfYear = month % 12
        const candidate = Date.UTC(
            year, monthOfYear, start.getUTCDate(),
            start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()
        )
        if (Date.UTC(year, monthOfYear, 1) > toMs) break
        // February has no 31st; RRule skips that month instead of moving it.
        if (new Date(candidate).getUTCMonth() === monthOfYear && candidate >= fromMs && candidate <= toMs) {
            result.push(new Date(candidate))
        }
        index += interval
    }
    return result
}

/** Occurrence starts in an inclusive window, using calendar arithmetic where possible. */
export function occurrenceStartsBetween(
    rule: string, dtstart: Date, from: Date, to: Date, limit = Number.POSITIVE_INFINITY
): Date[] {
    const parsed = parseRule(rule, dtstart)
    if (!parsed || from > to) return []
    try {
        return calendarStarts(parsed, from, to, limit) ?? parsed.between(from, to, true).slice(0, limit)
    } catch {
        return []
    }
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
    return occurrenceStartsBetween(rule, dtstart, from, to, limit)
        .map((start) => ({ start, end: new Date(start.getTime() + durationMinutes * 60_000) }))
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
        const fast = calendarStarts(
            parsed, from, new Date(from.getTime() + 100 * 366 * DAY_MS), count
        )
        if (fast) return fast.map((start) => ({ start, end: new Date(start.getTime() + durationMinutes * 60_000) }))

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
    try {
        const window = Math.max(durationMinutes, 1) * 60_000
        const candidates = occurrenceStartsBetween(rule, dtstart,
            new Date(now.getTime() - window),
            new Date(now.getTime() + graceMinutes * 60_000)
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
