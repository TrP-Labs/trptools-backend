import type { HostModel } from './model'
import type { DueCandidate, SchedulerConfig } from '../bot/schedulerRules'
import { GRACE_MS } from '../bot/schedulerRules'
import { occurrenceStartsBetween } from '../utils/recurrence'
import { BOT_ACTIONS } from './rules'

export function timelineCandidates(
    rule: string,
    start: Date,
    duration: number,
    schedule: HostModel.Schedule,
    config: SchedulerConfig,
    now: Date,
): DueCandidate[] {
    const enabled: Record<string, boolean> = {
        STAFF_START: config.signupsEnabled && config.autoStaffStart,
        BEGIN: config.announcementsEnabled && config.autoBegin,
        COMPLETE: config.autoComplete,
    }
    const offsets = schedule.entries.map((entry) => ({
        entry,
        offset:
            (entry.reference === 'END' ? duration : 0) * 60000 +
            entry.offsetMinutes * 60000,
    }))
    const result: DueCandidate[] = []
    for (const { entry, offset } of offsets) {
        if (
            !BOT_ACTIONS.has(entry.action) ||
            !entry.automation ||
            !enabled[entry.action]
        )
            continue
        const starts = occurrenceStartsBetween(
            rule,
            start,
            new Date(now.getTime() - offset - GRACE_MS),
            new Date(now.getTime() - offset),
        )
        const nextOffset = Math.min(
            offset + GRACE_MS,
            ...offsets
                .filter((other) => other.offset > offset)
                .map((other) => other.offset),
        )
        for (const occurrence of starts) {
            const expiresAt = new Date(occurrence.getTime() + nextOffset)
            if (now >= expiresAt) continue
            result.push({
                action: entry.action as DueCandidate['action'],
                occurrence,
                expiresAt,
            })
        }
    }
    return result
}
