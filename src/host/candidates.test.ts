import { expect, test } from 'bun:test'
import { timelineCandidates } from './candidates'
import { DEFAULT_SCHEDULE } from './rules'
import type { SchedulerConfig } from '../bot/schedulerRules'
const start = new Date('2026-09-27T12:00:00Z')
const config = {
    signupsEnabled: true,
    autoStaffStart: true,
    announcementsEnabled: true,
    autoBegin: true,
    autoComplete: true,
} as SchedulerConfig
test('saved timeline is used even before a host opens a room', () => {
    expect(
        timelineCandidates(
            'FREQ=DAILY',
            start,
            60,
            DEFAULT_SCHEDULE,
            config,
            new Date('2026-09-27T11:50:00Z'),
        )[0]?.action,
    ).toBe('STAFF_START')
    expect(
        timelineCandidates(
            'FREQ=DAILY',
            start,
            60,
            DEFAULT_SCHEDULE,
            config,
            new Date('2026-09-27T11:55:00Z'),
        ),
    ).toEqual([])
})
test('removing or disabling an event suppresses its automation', () => {
    expect(
        timelineCandidates(
            'FREQ=DAILY',
            start,
            60,
            { ...DEFAULT_SCHEDULE, entries: [] },
            config,
            start,
        ),
    ).toEqual([])
    expect(
        timelineCandidates(
            'FREQ=DAILY',
            start,
            60,
            DEFAULT_SCHEDULE,
            { ...config, autoBegin: false },
            start,
        ),
    ).toEqual([])
})
