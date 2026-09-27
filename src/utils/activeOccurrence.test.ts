import { expect, test } from 'bun:test'
import { activeOccurrence } from './recurrence'
const start = new Date('2026-09-27T12:00:00.000Z')
test('wrap-up returns the occurrence that ended, with its original end', () => {
    const now = new Date('2026-09-27T13:29:59Z')
    expect(activeOccurrence('FREQ=DAILY', start, 60, 10, now, 30)?.end.toISOString()).toBe('2026-09-27T13:00:00.000Z')
    expect(activeOccurrence('FREQ=DAILY', start, 60, 10, new Date('2026-09-27T13:30:00Z'), 30)).toBeNull()
})
test('opening lead stays independent of wrap-up grace', () => {
    expect(activeOccurrence('FREQ=DAILY', start, 60, 10, new Date('2026-09-27T11:49:59Z'), 30)).toBeNull()
    expect(activeOccurrence('FREQ=DAILY', start, 60, 10, new Date('2026-09-27T11:50:00Z'), 30)?.start).toEqual(start)
})
