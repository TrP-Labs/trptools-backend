import { and, eq, sql } from 'drizzle-orm'
import db from '../db'
import { events, shiftAttendance } from '../db/schema'
import { dataRedis } from '../utils/redis'
import { activeOccurrence } from '../utils/recurrence'
import { ensureInstance } from '../schedule/instances'
import type { RoomInfo } from '../rooms/service'
import { RECORD_ATTENDANCE } from './redisScripts'
import { attendanceStep } from './rules'
import type { RealtimeModel } from './model'

type Occurrence = { eventId: string; start: number; end: number }

const secondsKey = (occurrence: Occurrence) => `attendance:${occurrence.eventId}:${occurrence.start}`
const clockKey = (occurrence: Occurrence) => `${secondsKey(occurrence)}:clock`
const namesKey = (occurrence: Occurrence) => `${secondsKey(occurrence)}:names`
const occurrenceCacheKey = (groupId: string) => `gamefeed:${groupId}:occurrence`

/** Long enough to outlive the longest shift and its extensions. */
const ATTENDANCE_TTL_SECONDS = 60 * 60 * 36
const FLUSH_EVERY_MS = 60_000

/**
 * The shift the server is running for, when no room says so.
 *
 * A shift can run without anybody opening a room, and the drivers on it still
 * attended. Cached for a minute because it is the group's whole schedule
 * expanded, asked every fifteen seconds.
 */
async function scheduledOccurrence(groupId: string, now: number): Promise<Occurrence | null> {
    const cached = await dataRedis.get(occurrenceCacheKey(groupId))
    if (cached) {
        const parsed = cached === '-' ? null : JSON.parse(cached) as Occurrence
        if (!parsed || (now >= parsed.start && now < parsed.end + 60_000)) return parsed
    }
    const rules = await db.select().from(events).where(and(eq(events.groupId, groupId), eq(events.archived, false)))
    let found: Occurrence | null = null
    for (const event of rules) {
        const occurrence = activeOccurrence(event.rrule, event.startTime, event.duration, 0, new Date(now))
        if (occurrence && (!found || occurrence.start.getTime() < found.start)) {
            found = { eventId: event.eventId, start: occurrence.start.getTime(), end: occurrence.end.getTime() }
        }
    }
    await dataRedis.set(occurrenceCacheKey(groupId), found ? JSON.stringify(found) : '-', 'EX', 60)
    return found
}

/**
 * Credits everybody on the server with the time since the previous report.
 *
 * Counted in Redis because it changes every fifteen seconds for every player,
 * and written through to `shift_attendance` once a minute and once more when
 * the shift ends — the last write is the one the shift's history keeps.
 */
export async function recordAttendance(groupId: string, room: RoomInfo | null, people: RealtimeModel.User[], now: number) {
    const occurrence: Occurrence | null = room?.eventId && room.occurrence
        ? { eventId: room.eventId, start: Date.parse(room.occurrence), end: Number(room.expiresAt) }
        : await scheduledOccurrence(groupId, now)
    if (!occurrence || now < occurrence.start) return

    const previous = Number(await dataRedis.get(clockKey(occurrence))) || null
    await dataRedis.set(clockKey(occurrence), String(now), 'EX', ATTENDANCE_TTL_SECONDS)
    const step = attendanceStep(previous, now, occurrence.start, occurrence.end)
    const present = [...new Map(people.flatMap((person) => {
        const id = String(person.ID)
        return /^[0-9]{1,20}$/.test(id) && id !== '0' ? [[id, (person.Username ?? '').slice(0, 64) || id] as const] : []
    })).entries()]
    if (step > 0 && present.length) {
        await dataRedis.hset(namesKey(occurrence), Object.fromEntries(present))
        await dataRedis.expire(namesKey(occurrence), ATTENDANCE_TTL_SECONDS)
    }
    const final = now >= occurrence.end
    const flush = await dataRedis.eval<number>(RECORD_ATTENDANCE, [secondsKey(occurrence)],
        [String(now), String(step), String(FLUSH_EVERY_MS), String(ATTENDANCE_TTL_SECONDS), final ? '1' : '0', ...present.map(([id]) => id)])
    if (Number(flush) === 1) await flushAttendance(occurrence)
}

export async function flushAttendance(occurrence: Occurrence) {
    const [seconds, names] = await Promise.all([
        dataRedis.hgetall(secondsKey(occurrence)),
        dataRedis.hgetall(namesKey(occurrence))
    ])
    const rows = Object.entries(seconds).filter(([id]) => !id.startsWith('__'))
    if (!rows.length) return
    const [event] = await db.select().from(events).where(eq(events.eventId, occurrence.eventId)).limit(1)
    if (!event) return
    const instance = await ensureInstance(event, new Date(occurrence.start)).catch(() => null)
    if (!instance) return
    await db.insert(shiftAttendance)
        .values(rows.map(([robloxId, value]) => ({
            occurrenceId: instance.id, robloxId, name: names[robloxId] ?? robloxId, seconds: Number(value) || 0
        })))
        .onConflictDoUpdate({
            target: [shiftAttendance.occurrenceId, shiftAttendance.robloxId],
            // Redis holds the running total, so the larger figure is the newer one.
            set: { seconds: sql`greatest(${shiftAttendance.seconds}, excluded.seconds)`, name: sql`excluded.name`, updatedAt: sql`now()` }
        })
}
