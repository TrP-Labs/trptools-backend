import { describe, expect, test } from 'bun:test'
import { Frequency, RRule } from 'rrule'
import { activeOccurrence, occurrenceStartsBetween, upcomingOccurrences } from './recurrence'

describe('old recurring shifts', () => {
    const start = new Date('2019-01-31T18:30:00Z')
    const from = new Date('2026-09-20T00:00:00Z')
    const to = new Date('2026-10-20T23:59:59Z')

    const cases: Array<[string, ConstructorParameters<typeof RRule>[0]]> = [
        ['daily', { freq: Frequency.DAILY }],
        ['weekdays', { freq: Frequency.WEEKLY, byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR] }],
        ['fortnightly', { freq: Frequency.WEEKLY, interval: 2, byweekday: [RRule.MO, RRule.TH] }],
        ['monthly on the 31st', { freq: Frequency.MONTHLY }]
    ]

    for (const [name, options] of cases) {
        test(`${name} matches the RRULE library after years have passed`, () => {
            const rule = new RRule({ dtstart: start, ...options })
            expect(occurrenceStartsBetween(rule.toString(), start, from, to)).toEqual(rule.between(from, to, true))
        })
    }

    test('a finite custom rule keeps its original end', () => {
        const rule = new RRule({ dtstart: start, freq: Frequency.DAILY, count: 5 })
        expect(occurrenceStartsBetween(rule.toString(), start, from, to)).toEqual([])
    })

    test('the next occurrence still resolves beyond 2,000 previous days', () => {
        const rule = new RRule({ dtstart: start, freq: Frequency.DAILY }).toString()
        expect(upcomingOccurrences(rule, start, 60, from, 1)[0]?.start).toEqual(
            new Date('2026-09-20T18:30:00Z')
        )
        expect(activeOccurrence(rule, start, 60, 10, new Date('2026-09-20T18:25:00Z'))?.start).toEqual(
            new Date('2026-09-20T18:30:00Z')
        )
    })
})
