import { describe, expect, test } from 'bun:test'
import { dueCandidates, GRACE_MS, type SchedulerConfig } from './schedulerRules'

const config: SchedulerConfig = {
    announcementsEnabled: true,
    autoAnnounce: false,
    autoAnnounceLead: 1440,
    signupsEnabled: true,
    autoSignups: false,
    autoSignupsLead: 180,
    remindersEnabled: true,
    autoHostReminder: false,
    autoHostReminderLead: 30,
    autoStaffStart: false,
    autoStaffStartLead: 15,
    autoBegin: false,
    autoBeginLead: 0,
    autoComplete: false,
    autoCompleteDelay: 5
}

describe('dueCandidates', () => {
    test('finds a due action in a series older than 2,000 occurrences', () => {
        const now = new Date('2026-09-24T12:00:00Z')
        const due = dueCandidates(
            'FREQ=DAILY', new Date('2019-01-01T12:00:00Z'), 120,
            { ...config, autoBegin: true }, 1440, now
        )
        expect(due).toEqual([{
            action: 'BEGIN',
            occurrence: now,
            expiresAt: new Date(now.getTime() + GRACE_MS)
        }])
    })

    test('checks the exact grace window for early and late triggers', () => {
        const now = new Date('2026-09-24T12:00:00Z')
        const due = dueCandidates(
            'FREQ=DAILY', new Date('2026-09-20T12:30:00Z'), 120,
            { ...config, autoSignups: true, autoComplete: true }, 30, now
        )
        expect(due.map(({ action }) => action)).toEqual(['SIGNUPS'])
        expect(due[0]?.occurrence.toISOString()).toBe('2026-09-24T12:30:00.000Z')

        const complete = dueCandidates(
            'FREQ=DAILY', new Date('2026-09-20T09:55:00Z'), 120,
            { ...config, autoComplete: true }, 1440, now
        )
        expect(complete.map(({ action }) => action)).toEqual(['COMPLETE'])
        expect(complete[0]?.expiresAt.toISOString()).toBe('2026-09-24T12:10:00.000Z')
    })

    test('does not schedule disabled or expired actions', () => {
        const now = new Date('2026-09-24T12:00:00Z')
        const rule = 'FREQ=DAILY'
        expect(dueCandidates(rule, new Date('2026-09-20T12:00:00Z'), 120, config, 1440, now)).toEqual([])
        expect(dueCandidates(
            rule, new Date('2026-09-20T11:49:59Z'), 120,
            { ...config, autoBegin: true }, 1440, now
        )).toEqual([])
    })
})
