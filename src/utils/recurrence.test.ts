import { describe, expect, test } from 'bun:test'
import { Frequency, RRule } from 'rrule'
import { activeOccurrence, occurrenceStartsBetween, upcomingOccurrences, isValidRule } from './recurrence'

describe('old recurring shifts', () => {
    const start = new Date('2019-01-31T18:30:00Z')
    const from = new Date('2026-09-20T00:00:00Z')
    const to = new Date('2026-10-20T23:59:59Z')

    const cases: Array<[string, ConstructorParameters<typeof RRule>[0]]> = [
        ['daily', { freq: Frequency.DAILY }],
        ['hourly', { freq: Frequency.HOURLY, interval: 3 }],
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

test('public recurrence expansion refuses abusive frequencies and fan-out', () => {
    for (const rule of ['FREQ=SECONDLY', 'FREQ=MINUTELY', 'FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;COUNT=100000000', 'FREQ=DAILY;BYMINUTE=0,1,2,3,4;BYSECOND=0,1,2,3,4']) {
        expect(isValidRule(rule)).toBe(false)
        expect(occurrenceStartsBetween(rule, new Date('2000-01-01'), new Date('2026-01-01'), new Date('2026-01-02'))).toEqual([])
    }
    expect(isValidRule('FREQ=MONTHLY;BYDAY=1MO;COUNT=100')).toBe(true)
})


test('cached recurrence parsing respects edits and keeps caller dates independent', () => {
    const start = new Date('2026-09-29T12:00:00Z'), end = new Date('2026-10-10T12:00:00Z')
    const daily = 'FREQ=DAILY;COUNT=5'
    const first = occurrenceStartsBetween(daily, start, start, end, 2)
    expect(first).toEqual([new Date('2026-09-29T12:00:00Z'), new Date('2026-09-30T12:00:00Z')])
    first[0]!.setUTCFullYear(2000)
    expect(occurrenceStartsBetween(daily, start, start, end, 1)[0]).toEqual(start)
    expect(occurrenceStartsBetween('FREQ=WEEKLY;COUNT=5', start, start, end, 2)[1]).toEqual(new Date('2026-10-06T12:00:00Z'))
    const edited = new Date('2026-09-30T12:00:00Z')
    expect(occurrenceStartsBetween(daily, edited, start, end, 1)[0]).toEqual(edited)
    expect(occurrenceStartsBetween(daily, start, start, end, 10)).toHaveLength(5)
})
