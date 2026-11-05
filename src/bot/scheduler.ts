import { decideInstance, ensureInstance } from '../schedule/instances'
import { and, eq, or } from 'drizzle-orm'
import db from '../db'
import { botConfigs, events, groups } from '../db/schema'
import { dataRedis } from '../utils/redis'
import type { BotInternal } from './internalModel'
import { groupIndexKey, roomKey, roomChannel, type RoomInfo } from '../rooms/service'
import { sweepRoomScript } from '../rooms/lifecycle'
import { CLAIM_TIMELINE, FINISH_TIMELINE } from '../host/redisScripts'
import { timelineCandidates } from '../host/candidates'
import { DEFAULT_SCHEDULE } from '../host/rules'
import { dueCandidates, demandDecisionCandidates } from './schedulerRules'
import { readMemo, writeMemo } from '../utils/idle'

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

const POLL_ROOM = sweepRoomScript(CLAIM_TIMELINE)

const claimKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:lease:${action}:${eventId}:${occurrence.getTime()}`

const legacyClaimKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:fired:${action}:${eventId}:${occurrence.getTime()}`

const doneKey = (action: ActionName, eventId: string, occurrence: Date) =>
    `bot:done:${action}:${eventId}:${occurrence.getTime()}`

const CLAIM_TTL = 2 * 60
const DONE_TTL = 60 * 60 * 24

/**
 * Every bot-connected group's shifts and automation settings.
 *
 * Read on every poll — every thirty seconds from the long-running bot, every
 * minute from the Worker — and changed only when somebody edits a shift, the
 * bot page, the host schedule or the group, each of which forgets this memo
 * (`utils/idle.ts`). Remembering it in Redis lets an idle site go without
 * Postgres entirely; the day-long expiry only bounds a write that forgot to.
 */
async function schedulerRows() {
    const memo = await readMemo('scheduler')
    if (memo.value) {
        try { return revive(JSON.parse(memo.value)) } catch { /* reload below */ }
    }
    const rows = await loadRows()
    const encoded = JSON.stringify(rows)
    // Long shift descriptions across many groups could outgrow a sensible
    // Redis value; past that size every poll simply reads Postgres as before.
    if (encoded.length < 512 * 1024) await writeMemo('scheduler', memo.version, encoded, 86_400)
    return rows
}

// The Worker uses Neon's HTTP transport: one join avoids a database
// round trip for every guild before we even know whether a shift is due.
const loadRows = () => db
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
        shift: events
    })
    .from(botConfigs)
    .innerJoin(groups, eq(botConfigs.groupId, groups.id))
    .innerJoin(events, and(eq(events.groupId, groups.id), eq(events.archived, false)))

type SchedulerRow = Awaited<ReturnType<typeof loadRows>>[number]

/** JSON has no dates; these are the shift's timestamp columns. */
function revive(rows: SchedulerRow[]): SchedulerRow[] {
    for (const row of rows) {
        const shift = row.shift as Record<string, unknown>
        for (const field of ['startTime', 'createdAt', 'updatedAt', 'notificationAt']) {
            if (typeof shift[field] === 'string') shift[field] = new Date(shift[field] as string)
        }
    }
    return rows
}

export async function dueActions(
    now = new Date(),
    mode: 'legacy' | 'leased' = 'legacy'
): Promise<BotInternal.dueActions> {
    const rows = await schedulerRows()

    const due: BotInternal.dueActions = []
    const groupIds = [...new Set(rows.map(row => row.groupId))]
    // One MGET for every group's room pointer, and one script per open room
    // that keeps it alive, settles its timeline and claims what is due: a
    // request per group plus three per room before.
    const indexes = groupIds.length ? await dataRedis.mget(groupIds.map(groupIndexKey)) : []
    const open = new Map<string, { id: string; info: Partial<RoomInfo> }>()
    for (let index = 0; index < groupIds.length; index++) {
        const roomId = indexes[index]
        if (!roomId) continue
        const groupId = groupIds[index]!
        const raw = await dataRedis.eval<string | number | null>(POLL_ROOM, [roomKey(roomId)],
            [String(now.getTime()), roomId, roomChannel(roomId), 'POLL'])
        if (typeof raw !== 'string') continue
        const polled = JSON.parse(raw) as { eventId: string; occurrence: string; due: unknown }
        if (!polled.eventId) continue
        open.set(groupId, { id: roomId, info: { eventId: polled.eventId, occurrence: polled.occurrence } })
        const config = rows.find(row => row.groupId === groupId)!.config
        const claimed = (Array.isArray(polled.due) ? polled.due : []) as Array<{ action: ActionName; eventId: string; occurrence: string; expiresAt: number; roomId: string; timelineId: string }>
        for (const item of claimed) due.push({ ...item, guildId: config.guildId, groupId, expiresAt: new Date(item.expiresAt).toISOString() })
    }

    for (const { config, groupId, signupLeadMinutes, hostSchedule, shift } of rows) {
        for (const candidate of [
            ...dueCandidates(shift.rrule, shift.startTime, shift.duration, shift.onDemand ? { ...config,
                autoAnnounce: true, autoAnnounceLead: shift.voteLeadMinutes,
                autoSignupsLead: Math.min(config.autoSignupsLead, shift.decisionLeadMinutes),
                autoHostReminderLead: Math.min(config.autoHostReminderLead, shift.decisionLeadMinutes)
            } : config, signupLeadMinutes, now)
                .filter(item => !['STAFF_START','BEGIN','COMPLETE'].includes(item.action)),
            ...(shift.onDemand ? demandDecisionCandidates(shift.rrule, shift.startTime, shift.decisionLeadMinutes, now) : []),
            ...timelineCandidates(shift.rrule, shift.startTime, shift.duration, shift.onDemand ? {
                ...(hostSchedule ?? DEFAULT_SCHEDULE), entries: (hostSchedule ?? DEFAULT_SCHEDULE).entries.map(entry => ({ ...entry,
                    offsetMinutes: Math.max(entry.offsetMinutes, -shift.decisionLeadMinutes - (entry.reference === 'END' ? shift.duration : 0))
                }))
            } : hostSchedule ?? DEFAULT_SCHEDULE, config, now)
        ]) {
            const { action, occurrence, expiresAt } = candidate
            const instance = await decideInstance(await ensureInstance(shift, occurrence), now)
            if (!['ANNOUNCE', 'REFRESH'].includes(action) && !['SCHEDULED', 'CONFIRMED'].includes(instance.decision)) continue
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
    const when = new Date(occurrence)
    if (roomId && timelineId) {
        await finishTimeline(roomId, timelineId, 'COMPLETE')
        // The room's timeline is not the only record anybody reads. Without
        // the done marker, closing the room handed the same action to the
        // scheduler again, and reopening it put the card back to waiting.
        if (action !== 'REFRESH' && !Number.isNaN(when.getTime())) await dataRedis.set(doneKey(action, eventId, when), '1', 'EX', DONE_TTL)
        return
    }
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
