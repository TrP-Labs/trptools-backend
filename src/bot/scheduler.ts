import { eq } from 'drizzle-orm'
import db from '../db'
import { botConfigs, events, groups } from '../db/schema'
import { dataRedis } from '../utils/redis'
import { upcomingOccurrences } from '../utils/recurrence'
import type { BotInternal } from './internalModel'

/**
 * Works out which automated actions are due, and hands each out exactly once.
 *
 * This lives in the API rather than in the bot because recurrence expansion
 * and the group's configuration are both here — the bot would otherwise need
 * the whole schedule and a copy of the rules to decide anything.
 *
 * Handing an action out claims it. `SET NX` against a key naming the exact
 * action, shift and occurrence is what stops a restarted bot, or two bots,
 * announcing the same shift twice. The claim outlives the occurrence by a day
 * so a late poll cannot resurrect one.
 */

type ActionName = BotInternal.dueAction['action']

const claimKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:fired:${action}:${eventId}:${occurrence.getTime()}`

const CLAIM_TTL = 60 * 60 * 24

/**
 * How late an action may still fire after its moment passed.
 *
 * A bot that was down for two minutes should still announce a shift; one that
 * was down for a day should not suddenly post yesterday's. Ten minutes is
 * comfortably longer than any restart and short enough to stay relevant.
 */
const GRACE_MS = 10 * 60 * 1000

type Trigger = {
    action: ActionName
    enabled: boolean
    /** Milliseconds relative to the occurrence start; negative is before. */
    offsetMs: number
}

function triggersFor(
    config: typeof botConfigs.$inferSelect,
    durationMinutes: number,
    signupLeadMinutes: number
): Trigger[] {
    return [
        {
            action: 'ANNOUNCE',
            enabled: config.announcementsEnabled && config.autoAnnounce,
            offsetMs: -config.autoAnnounceLead * 60_000
        },
        {
            action: 'SIGNUPS',
            enabled: config.signupsEnabled && config.autoSignups,
            // Clamped to the group's own sign-up window. Posting a sheet
            // earlier than that gives people a form whose website half refuses
            // them, and the two settings live on different pages, so the
            // combination is easy to get wrong by accident.
            offsetMs: -Math.min(config.autoSignupsLead, signupLeadMinutes) * 60_000
        },
        {
            action: 'HOST_REMINDER',
            enabled: config.remindersEnabled && config.autoHostReminder,
            offsetMs: -config.autoHostReminderLead * 60_000
        },
        {
            // Staff who signed up get the join code before the announcement
            // goes out, which is the whole point of signing up: they are
            // expected in position before anybody else arrives.
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
            // The only one measured from the end of the shift rather than its
            // start, because closing out is what happens once it is over.
            action: 'COMPLETE',
            enabled: config.autoComplete,
            offsetMs: durationMinutes * 60_000 + config.autoCompleteDelay * 60_000
        }
    ]
}

export async function dueActions(now = new Date()): Promise<BotInternal.dueActions> {
    const rows = await db
        .select({ config: botConfigs, group: groups })
        .from(botConfigs)
        .innerJoin(groups, eq(botConfigs.groupId, groups.id))

    if (rows.length === 0) return []

    const due: BotInternal.dueActions = []

    for (const { config, group } of rows) {
        const shifts = await db.select().from(events).where(eq(events.groupId, group.id))
        if (shifts.length === 0) continue

        for (const shift of shifts) {
            const triggers = triggersFor(config, shift.duration, group.signupLeadMinutes).filter(
                (trigger) => trigger.enabled
            )
            if (triggers.length === 0) continue

            // The furthest-ahead trigger decides how far to expand. Anything
            // beyond that window cannot be due yet by definition.
            const horizon = Math.max(...triggers.map((trigger) => Math.abs(trigger.offsetMs)))

            const occurrences = upcomingOccurrences(
                shift.rrule,
                shift.startTime,
                shift.duration,
                new Date(now.getTime() - horizon - GRACE_MS),
                40
            )

            for (const occurrence of occurrences) {
                for (const trigger of triggers) {
                    const fireAt = occurrence.start.getTime() + trigger.offsetMs
                    const age = now.getTime() - fireAt

                    if (age < 0 || age > GRACE_MS) continue

                    const claimed = await dataRedis.set(
                        claimKey(trigger.action, shift.eventId, occurrence.start),
                        '1',
                        'EX',
                        CLAIM_TTL,
                        'NX'
                    )

                    if (!claimed) continue

                    due.push({
                        guildId: config.guildId,
                        groupId: group.id,
                        action: trigger.action,
                        eventId: shift.eventId,
                        occurrence: occurrence.start.toISOString()
                    })
                }
            }
        }
    }

    return due
}

/**
 * Gives an action back when the bot could not carry it out.
 *
 * Without this a transient Discord failure would silently consume the shift's
 * only chance to be announced, and nothing would ever say so.
 */
export async function releaseClaim(action: ActionName, eventId: string, occurrence: string) {
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return

    await dataRedis.del(claimKey(action, eventId, when)).catch(() => undefined)
}
