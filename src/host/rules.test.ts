import { expect, test } from 'bun:test'
import { DEFAULT_SCHEDULE, makeTimeline, validSchedule } from './rules'
test('default schedule has separate depot reminder and occurrence-relative clocks', () => {
    const timeline = makeTimeline(DEFAULT_SCHEDULE, 1_000_000, 4_600_000, { BEGIN: true })
    expect(timeline.map(item => item.dueAt)).toEqual([400000, 700000, 1000000, 4000000, 4900000])
    expect(timeline.find(item => item.action === 'BEGIN')?.automation).toBe(true)
    expect(timeline.find(item => item.action === 'STAFF_START')?.automation).toBe(false)
    expect(DEFAULT_SCHEDULE.entries).toHaveLength(4)
})
test('disabling reminders removes them and duplicate automation actions are rejected', () => {
    expect(makeTimeline({ ...DEFAULT_SCHEDULE, depotReminderEnabled: false }, 0, 3600000)).toHaveLength(4)
    expect(validSchedule({ ...DEFAULT_SCHEDULE, entries: [...DEFAULT_SCHEDULE.entries, { ...DEFAULT_SCHEDULE.entries[0]!, id: 'another' }] })).toBe(false)
    expect(validSchedule(DEFAULT_SCHEDULE)).toBe(true)
})
