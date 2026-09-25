import type { botConfigs } from '../db/schema'
import { parseRule } from '../utils/recurrence'
import type { BotInternal } from './internalModel'

type ActionName = BotInternal.dueAction['action']

export type SchedulerConfig = Pick<typeof botConfigs.$inferSelect,
    | 'announcementsEnabled' | 'autoAnnounce' | 'autoAnnounceLead'
    | 'signupsEnabled' | 'autoSignups' | 'autoSignupsLead'
    | 'remindersEnabled' | 'autoHostReminder' | 'autoHostReminderLead'
    | 'autoStaffStart' | 'autoStaffStartLead'
    | 'autoBegin' | 'autoBeginLead'
    | 'autoComplete' | 'autoCompleteDelay'
>

/** A bot that was briefly down can catch up, without announcing an old shift. */
export const GRACE_MS = 10 * 60 * 1000

type Trigger = {
    action: ActionName
    enabled: boolean
    /** Milliseconds relative to the occurrence start; negative is before. */
    offsetMs: number
}

function triggersFor(config: SchedulerConfig, durationMinutes: number, signupLeadMinutes: number): Trigger[] {
    return [
        {
            action: 'ANNOUNCE',
            enabled: config.announcementsEnabled && config.autoAnnounce,
            offsetMs: -config.autoAnnounceLead * 60_000
        },
        {
            action: 'SIGNUPS',
            enabled: config.signupsEnabled && config.autoSignups,
            // The group's own sign-up window must be open before a sheet is posted.
            offsetMs: -Math.min(config.autoSignupsLead, signupLeadMinutes) * 60_000
        },
        {
            action: 'HOST_REMINDER',
            enabled: config.remindersEnabled && config.autoHostReminder,
            offsetMs: -config.autoHostReminderLead * 60_000
        },
        {
            action: 'STAFF_START',
            enabled: config.signupsEnabled && config.autoStaffStart,
            offsetMs: -config.autoStaffStartLead * 60_000
        },
        {
            action: 'BEGIN',
            enabled: config.announcementsEnabled && config.autoBegin,
            offsetMs: -config.autoBeginLead * 60_000
        },
        {
            action: 'COMPLETE',
            enabled: config.autoComplete,
            offsetMs: durationMinutes * 60_000 + config.autoCompleteDelay * 60_000
        }
    ]
}

export type DueCandidate = {
    action: ActionName
    occurrence: Date
    expiresAt: Date
}

/** Expand only the occurrence starts that could fire in this poll's grace window. */
export function dueCandidates(
    rule: string,
    startTime: Date,
    durationMinutes: number,
    config: SchedulerConfig,
    signupLeadMinutes: number,
    now: Date
): DueCandidate[] {
    const triggers = triggersFor(config, durationMinutes, signupLeadMinutes).filter((trigger) => trigger.enabled)
    if (triggers.length === 0) return []

    const parsed = parseRule(rule, startTime)
    if (!parsed) return []

    const candidates: DueCandidate[] = []
    try {
        for (const trigger of triggers) {
            const from = new Date(now.getTime() - GRACE_MS - trigger.offsetMs)
            const to = new Date(now.getTime() - trigger.offsetMs)
            for (const occurrence of parsed.between(from, to, true)) {
                candidates.push({
                    action: trigger.action,
                    occurrence,
                    expiresAt: new Date(occurrence.getTime() + trigger.offsetMs + GRACE_MS)
                })
            }
        }
    } catch {
        return []
    }
    return candidates
}
