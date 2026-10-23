import { describe, expect, test } from 'bun:test'
import { boundsFor, monthOf, periodOf, periodRange, scoreShift, shiftPoints, totalPoints, verdictFor, type RankRules, type ShiftWindow } from './points'

const rules = (overrides: Partial<RankRules> = {}): RankRules => ({
    id: 'driver', minPoints: 2, maxPoints: 4, requiredPercent: 50, unsignedPoints: 0.5, noShowPoints: 0,
    promotionRankId: 'senior', demotionRankId: 'trainee', slotPoints: new Map([['dispatcher', 2]]), ...overrides
})
const hour: ShiftWindow = { id: 's1', start: 0, end: 3_600_000, tracked: true }

describe('one shift', () => {
    test('turning up past the threshold earns the unsigned points', () => {
        expect(shiftPoints(rules(), hour, { seconds: 1800 })).toBe(0.5)
        expect(shiftPoints(rules(), hour, { seconds: 1799 })).toBe(0)
    })

    test('a sign-up replaces, never adds to, the unsigned points', () => {
        expect(shiftPoints(rules(), hour, { seconds: 3600, slotId: 'dispatcher' })).toBe(2)
        expect(shiftPoints(rules({ slotPoints: new Map() }), hour, { seconds: 3600, slotId: 'driver' })).toBe(1)
        expect(shiftPoints(rules({ unsignedPoints: 3 }), hour, { seconds: 3600, slotId: 'driver' })).toBe(1)
    })

    test('a sign-up still has to turn up on a tracked shift', () => {
        expect(shiftPoints(rules(), hour, { slotId: 'dispatcher' })).toBe(0)
    })

    test('an untracked shift takes a sign-up at its word, and nothing else', () => {
        const untracked = { ...hour, tracked: false }
        expect(shiftPoints(rules(), untracked, { slotId: 'dispatcher' })).toBe(2)
        expect(shiftPoints(rules(), untracked, {})).toBe(0)
    })

    test('a no-show costs the penalty only on a tracked shift', () => {
        const strict = rules({ noShowPoints: 1.5 })
        expect(shiftPoints(strict, hour, { slotId: 'dispatcher', seconds: 600 })).toBe(-1.5)
        expect(shiftPoints(strict, { ...hour, tracked: false }, { slotId: 'dispatcher' })).toBe(2)
        // Turning up without signing up is never penalised, however short.
        expect(shiftPoints(strict, hour, { seconds: 60 })).toBe(0)
        // Off by default: a missed slot is simply worth nothing.
        expect(shiftPoints(rules(), hour, { slotId: 'dispatcher' })).toBe(0)
    })

    test('a score says why', () => {
        expect(scoreShift(rules({ noShowPoints: 1 }), hour, { slotId: 'dispatcher', seconds: 900 })).toEqual({ points: -1, reason: 'NO_SHOW', percent: 25 })
        expect(scoreShift(rules(), hour, { slotId: 'dispatcher', seconds: 3600 })).toEqual({ points: 2, reason: 'SIGNED_UP', percent: 100 })
        expect(scoreShift(rules(), { ...hour, tracked: false }, { slotId: 'x' })).toEqual({ points: 1, reason: 'TAKEN_AT_WORD', percent: null })
        expect(scoreShift(rules(), hour, { seconds: 900 }).reason).toBe('SHORT')
        expect(scoreShift(rules(), hour, { seconds: 1800 }).reason).toBe('PRESENT')
    })

    test('a threshold of zero counts anybody seen at all', () => {
        expect(shiftPoints(rules({ requiredPercent: 0 }), hour, {})).toBe(0.5)
    })
})

describe('a month', () => {
    test('sums and counts the shifts that earned anything', () => {
        const shifts = [hour, { ...hour, id: 's2' }, { ...hour, id: 's3' }]
        const activity = new Map([['s1', { seconds: 3600 }], ['s2', { seconds: 3600, slotId: 'dispatcher' }], ['s3', { seconds: 60 }]])
        expect(totalPoints(rules(), shifts, activity)).toEqual({ points: 2.5, counted: 2 })
    })

    test('over the maximum promotes, under the minimum demotes, strictly', () => {
        expect(verdictFor(rules(), 4.5)).toBe('PROMOTE')
        expect(verdictFor(rules(), 4)).toBeNull()
        expect(verdictFor(rules(), 2)).toBeNull()
        expect(verdictFor(rules(), 1.5)).toBe('DEMOTE')
    })

    test('zero is a real bound and null is none', () => {
        expect(verdictFor(rules({ maxPoints: 0 }), 0.5)).toBe('PROMOTE')
        expect(verdictFor(rules({ minPoints: 0 }), 0)).toBeNull()
        expect(verdictFor(rules({ minPoints: null, maxPoints: null }), 99)).toBeNull()
    })

    test('a bound with nowhere to go decides nothing', () => {
        expect(verdictFor(rules({ promotionRankId: null }), 10)).toBeNull()
        expect(verdictFor(rules({ demotionRankId: null }), 0)).toBeNull()
    })

    test('a penalty can take the total below zero, and a no-show is not a counted shift', () => {
        const shifts = [hour, { ...hour, id: 's2' }]
        const activity = new Map([['s1', { slotId: 'dispatcher' }], ['s2', { seconds: 3600 }]])
        expect(totalPoints(rules({ noShowPoints: 1 }), shifts, activity)).toEqual({ points: -0.5, counted: 1 })
    })

    test('months are UTC calendar months', () => {
        expect(periodRange('2026-12')).toEqual({ from: new Date('2026-12-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z'), months: 1, kind: 'MONTH' })
        expect(periodRange('2026-13')).toBeNull()
        expect(monthOf(new Date('2026-10-31T23:59:00Z'))).toBe('2026-10')
    })
})

describe('a quarter', () => {
    test('is three UTC calendar months', () => {
        expect(periodRange('2026-Q4')).toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z'), months: 3, kind: 'QUARTER' })
        expect(periodRange('2026-Q1')!.from).toEqual(new Date('2026-01-01T00:00:00Z'))
        expect(periodRange('2026-Q5')).toBeNull()
        expect(periodOf(new Date('2026-09-30T23:59:00Z'), 'QUARTER')).toBe('2026-Q3')
        expect(periodOf(new Date('2026-10-01T00:00:00Z'), 'QUARTER')).toBe('2026-Q4')
        expect(periodOf(new Date('2026-10-01T00:00:00Z'), 'MONTH')).toBe('2026-10')
    })

    test('holds somebody to three months of the monthly bounds', () => {
        expect(boundsFor(rules(), 3)).toEqual({ minPoints: 6, maxPoints: 12 })
        expect(boundsFor(rules({ minPoints: null }), 3)).toEqual({ minPoints: null, maxPoints: 12 })
        // Five points promote over a month and are comfortably inside a quarter.
        expect(verdictFor(rules(), 5)).toBe('PROMOTE')
        expect(verdictFor(rules(), 5, 3)).toBe('DEMOTE')
        expect(verdictFor(rules(), 12.5, 3)).toBe('PROMOTE')
    })
})
