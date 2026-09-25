import { and, eq, or } from 'drizzle-orm'
import db from '../db'
import { botConfigs, events, groups } from '../db/schema'
import { dataRedis } from '../utils/redis'
import type { BotInternal } from './internalModel'
import { dueCandidates } from './schedulerRules'

/**
 * Works out which automated actions are due and claims them for delivery.
 *
 * This lives in the API rather than in the bot because recurrence expansion
 * and the group's configuration are both here — the bot would otherwise need
 * the whole schedule and a copy of the rules to decide anything.
 *
 * The legacy bot uses a one-day claim. The Worker uses a short lease followed
 * by an explicit completion record, so a crashed delivery can be retried.
 */

type ActionName = BotInternal.dueAction['action']

const claimKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:lease:${action}:${eventId}:${occurrence.getTime()}`

const legacyClaimKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:fired:${action}:${eventId}:${occurrence.getTime()}`

const doneKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:done:${action}:${eventId}:${occurrence.getTime()}`

const CLAIM_TTL = 2 * 60
const DONE_TTL = 60 * 60 * 24

export async function dueActions(
    now = new Date(),
    mode: 'legacy' | 'leased' = 'legacy'
): Promise<BotInternal.dueActions> {
    // The Worker uses Neon's HTTP transport: one join avoids a database
    // round trip for every guild before we even know whether a shift is due.
    const rows = await db
        .select({
            config: {
                guildId: botConfigs.guildId,
                announcementsEnabled: botConfigs.announcementsEnabled,
                autoAnnounce: botConfigs.autoAnnounce,
                autoAnnounceLead: botConfigs.autoAnnounceLead,
                signupsEnabled: botConfigs.signupsEnabled,
                autoSignups: botConfigs.autoSignups,
                autoSignupsLead: botConfigs.autoSignupsLead,
                remindersEnabled: botConfigs.remindersEnabled,
                autoHostReminder: botConfigs.autoHostReminder,
                autoHostReminderLead: botConfigs.autoHostReminderLead,
                autoStaffStart: botConfigs.autoStaffStart,
                autoStaffStartLead: botConfigs.autoStaffStartLead,
                autoBegin: botConfigs.autoBegin,
                autoBeginLead: botConfigs.autoBeginLead,
                autoComplete: botConfigs.autoComplete,
                autoCompleteDelay: botConfigs.autoCompleteDelay
            },
            groupId: groups.id,
            signupLeadMinutes: groups.signupLeadMinutes,
            shift: {
                eventId: events.eventId,
                startTime: events.startTime,
                rrule: events.rrule,
                duration: events.duration
            }
        })
        .from(botConfigs)
        .innerJoin(groups, eq(botConfigs.groupId, groups.id))
        .innerJoin(events, eq(events.groupId, groups.id))
        .where(or(
            and(eq(botConfigs.announcementsEnabled, true), eq(botConfigs.autoAnnounce, true)),
            and(eq(botConfigs.signupsEnabled, true), eq(botConfigs.autoSignups, true)),
            and(eq(botConfigs.remindersEnabled, true), eq(botConfigs.autoHostReminder, true)),
            and(eq(botConfigs.signupsEnabled, true), eq(botConfigs.autoStaffStart, true)),
            and(eq(botConfigs.announcementsEnabled, true), eq(botConfigs.autoBegin, true)),
            eq(botConfigs.autoComplete, true)
        ))

    const due: BotInternal.dueActions = []

    for (const { config, groupId, signupLeadMinutes, shift } of rows) {
        for (const candidate of dueCandidates(
            shift.rrule, shift.startTime, shift.duration, config, signupLeadMinutes, now
        )) {
            const { action, occurrence, expiresAt } = candidate
            if (await dataRedis.exists(doneKey(action, shift.eventId, occurrence))) continue
            if (mode === 'leased' && await dataRedis.exists(legacyClaimKey(action, shift.eventId, occurrence))) continue
            if (mode === 'legacy' && await dataRedis.exists(claimKey(action, shift.eventId, occurrence))) continue

            const claimed = await dataRedis.set(
                mode === 'leased'
                    ? claimKey(action, shift.eventId, occurrence)
                    : legacyClaimKey(action, shift.eventId, occurrence),
                '1',
                'EX',
                mode === 'leased' ? CLAIM_TTL : DONE_TTL,
                'NX'
            )

            if (!claimed) continue

            due.push({
                guildId: config.guildId,
                groupId,
                action,
                eventId: shift.eventId,
                occurrence: occurrence.toISOString(),
                expiresAt: expiresAt.toISOString()
            })
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
export async function releaseClaim(
    action: ActionName, eventId: string, occurrence: string, mode: 'legacy' | 'leased' = 'legacy'
) {
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return

    await dataRedis.del(mode === 'leased' ? claimKey(action, eventId, when) : legacyClaimKey(action, eventId, when))
        .catch(() => undefined)
}

/** Finish a claimed action; a crashed worker's short lease otherwise expires for retry. */
export async function completeClaim(action: ActionName, eventId: string, occurrence: string) {
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return

    await dataRedis.set(doneKey(action, eventId, when), '1', 'EX', DONE_TTL)
    await dataRedis.del(claimKey(action, eventId, when))
}

export async function claimCompleted(action: ActionName, eventId: string, occurrence: string) {
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return false
    return Boolean(await dataRedis.exists(doneKey(action, eventId, when)))
}
