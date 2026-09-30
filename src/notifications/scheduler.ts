import { and, eq, lte, sql } from 'drizzle-orm'
import db from '../db'
import { databaseRows } from '../db/rows'
import { events } from '../db/schema'
import { upcomingOccurrences } from '../utils/recurrence'
import { notificationsConfigured } from './service'

/** Each plan and send is a separate Worker invocation; the cron only dispatches bounded I/O. */
export async function runNotificationTick(dispatch: (kind: 'plan' | 'send', id: string) => Promise<unknown>, now = new Date()) {
    if (!notificationsConfigured()) return
    if (now.getUTCMinutes() === 0) {
        await db.execute(sql`DELETE FROM notification_deliveries WHERE occurrence < ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}`)
    }
    const due = await db.select({ id: events.eventId }).from(events)
        .where(lte(events.notificationAt, now)).orderBy(events.notificationAt).limit(5)
    await Promise.all(due.map((event) => dispatch('plan', event.id)))
    const jobs = await db.execute(sql`SELECT id FROM notification_deliveries
        WHERE delivered_at IS NULL AND attempts < 5 AND available_at <= ${now.toISOString()}
        AND occurrence > ${new Date(now.getTime() - 15 * 60_000).toISOString()} ORDER BY available_at LIMIT 20`)
    await Promise.all(databaseRows(jobs).map((job) => dispatch('send', String(job.id))))
}

export async function planNotification(eventId: string, now = new Date()) {
    const [event] = await db.select().from(events).where(and(eq(events.eventId, eventId), lte(events.notificationAt, now))).limit(1)
    if (!event) return
    // Include a recently-started shift after a short scheduler outage, never an old occurrence.
    const occurrences = upcomingOccurrences(event.rrule, event.startTime, event.duration, new Date(now.getTime() - 5 * 60_000), 2)
    const current = occurrences[0]
    if (current && current.start.getTime() - 10 * 60_000 <= now.getTime()) {
        await db.execute(sql`INSERT INTO notification_deliveries (subscription_id, event_id, occurrence)
            SELECT DISTINCT p.id, e.event_id, ${current.start.toISOString()}::timestamptz
            FROM events e JOIN groups g ON g.id = e.group_id
            JOIN notification_watches w ON w.group_id = g.id AND (w.event_id IS NULL OR w.event_id = e.event_id)
            JOIN push_subscriptions p ON p.user_id = w.user_id
            JOIN users u ON u.id = p.user_id
            WHERE e.event_id = ${eventId} AND e.visibility = 'PUBLIC' AND g.visibility <> 'PRIVATE'
                AND g.moderation <> 'HIDDEN' AND g.show_shifts
                AND (u.banned_at IS NULL OR u.ban_expires_at <= ${now.toISOString()})
            ON CONFLICT DO NOTHING`)
    }
    const next = occurrences.find((occurrence) => occurrence.start.getTime() - 10 * 60_000 > now.getTime())
    await db.update(events).set({ notificationAt: next ? new Date(next.start.getTime() - 10 * 60_000) : null })
        .where(and(eq(events.eventId, eventId), eq(events.updatedAt, event.updatedAt)))
}
