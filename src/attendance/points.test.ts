import { describe, expect, test } from 'bun:test'
import { monthOf, monthRange, shiftPoints, totalPoints, verdictFor, type RankRules, type ShiftWindow } from './points'

const rules = (overrides: Partial<RankRules> = {}): RankRules => ({
    id: 'driver', minPoints: 2, maxPoints: 4, requiredPercent: 50, unsignedPoints: 0.5,
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

    test('months are UTC calendar months', () => {
        expect(monthRange('2026-12')).toEqual({ from: new Date('2026-12-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') })
        expect(monthRange('2026-13')).toBeNull()
        expect(monthOf(new Date('2026-10-31T23:59:00Z'))).toBe('2026-10')
    })
})
