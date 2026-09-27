import { and, eq, or } from 'drizzle-orm'
import db from '../db'
import { botConfigs, events, groups } from '../db/schema'
import { dataRedis } from '../utils/redis'
import type { BotInternal } from './internalModel'
import { groupIndexKey, roomKey, roomChannel, touchRoom, type RoomInfo } from '../rooms/service'
import { CLAIM_TIMELINE, FINISH_TIMELINE } from '../host/redisScripts'
import { runBatches, assertResults } from '../rooms/dispatch/batch'
import { timelineCandidates } from '../host/candidates'
import { DEFAULT_SCHEDULE } from '../host/rules'
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
            hostSchedule: groups.hostSchedule,
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


    const due: BotInternal.dueActions = []

    const groupIds = [...new Set(rows.map(row => row.groupId))]
    const indexes = await runBatches(dataRedis, groupIds.map(id => pipeline => pipeline.eval("return redis.call('GET', KEYS[1])", [groupIndexKey(id)], [])))
    assertResults(indexes)
    const open = new Map<string, { id: string; info: Partial<RoomInfo> }>()
    const ids = indexes.flatMap(([, value], index) => typeof value === 'string' ? [{ id: value, groupId: groupIds[index]! }] : [])
    const rooms = await runBatches(dataRedis, ids.map(room => pipeline => pipeline.hgetall(roomKey(room.id))))
    assertResults(rooms)
    for (let index = 0; index < ids.length; index++) {
        const pointer = ids[index]!
        const info = rooms[index]![1] as Partial<RoomInfo>
        if (!info.timeline || !info.eventId) continue
        if (!await touchRoom(pointer.id)) continue
        open.set(pointer.groupId, { id: pointer.id, info })
        const config = rows.find(row => row.groupId === pointer.groupId)!.config
        const raw = await dataRedis.eval<string>(CLAIM_TIMELINE, [roomKey(pointer.id)],
            [String(now.getTime()), pointer.id, roomChannel(pointer.id), 'POLL'])
        const claimed = raw ? JSON.parse(raw) as Array<{ action: ActionName; eventId: string; occurrence: string; expiresAt: number; roomId: string; timelineId: string }> : []
        for (const item of claimed) due.push({ ...item, guildId: config.guildId, groupId: pointer.groupId, expiresAt: new Date(item.expiresAt).toISOString() })
    }

    for (const { config, groupId, signupLeadMinutes, hostSchedule, shift } of rows) {
        for (const candidate of [
            ...dueCandidates(shift.rrule, shift.startTime, shift.duration, config, signupLeadMinutes, now)
                .filter(item => !['STAFF_START','BEGIN','COMPLETE'].includes(item.action)),
            ...timelineCandidates(shift.rrule, shift.startTime, shift.duration, hostSchedule ?? DEFAULT_SCHEDULE, config, now)
        ]) {
            const { action, occurrence, expiresAt } = candidate
            const room = open.get(groupId)
            if (room?.info.eventId === shift.eventId && room.info.occurrence === occurrence.toISOString() && ['STAFF_START', 'BEGIN', 'COMPLETE'].includes(action)) continue
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
    action: ActionName, eventId: string, occurrence: string, mode: 'legacy' | 'leased' = 'legacy', roomId?: string, timelineId?: string
) {
    if (roomId && timelineId) { await finishTimeline(roomId, timelineId, 'RELEASE'); return }
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return

    await dataRedis.del(mode === 'leased' ? claimKey(action, eventId, when) : legacyClaimKey(action, eventId, when))
        .catch(() => undefined)
}

/** Finish a claimed action; a crashed worker's short lease otherwise expires for retry. */
export async function completeClaim(action: ActionName, eventId: string, occurrence: string, roomId?: string, timelineId?: string) {
    if (roomId && timelineId) { await finishTimeline(roomId, timelineId, 'COMPLETE'); return }
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return

    await dataRedis.set(doneKey(action, eventId, when), '1', 'EX', DONE_TTL)
    await dataRedis.del(claimKey(action, eventId, when))
}

export async function claimCompleted(action: ActionName, eventId: string, occurrence: string, roomId?: string, timelineId?: string) {
    if (roomId && timelineId) {
        const info = await dataRedis.hgetall(roomKey(roomId)) as Partial<RoomInfo>
        if (!info.timeline) return true
        if (action === 'REFRESH') return timelineId !== `refresh-${(info as Record<string,string>).needsRefresh}`
        const timeline = JSON.parse(info.timeline) as Array<{id:string;status:string}>
        return !timeline.some(item => item.id === timelineId && item.status === 'RUNNING')
    }
    const when = new Date(occurrence)
    if (Number.isNaN(when.getTime())) return false
    return Boolean(await dataRedis.exists(doneKey(action, eventId, when)))
}

export async function finishTimeline(roomId: string, id: string, operation: 'COMPLETE' | 'RELEASE') {
    await dataRedis.eval(FINISH_TIMELINE, [roomKey(roomId)], [String(Date.now()), roomId, roomChannel(roomId), id, operation])
}
