import { and, eq, sql } from 'drizzle-orm'
import db from '../db'
import { databaseRows } from '../db/rows'
import { notificationDeliveries, pushSubscriptions } from '../db/schema'
import { decryptSecret } from '../utils/crypto'
import { occurrenceStartsBetween } from '../utils/recurrence'
import { FRONTEND_URL } from '../utils/env'
import { retryDelay, validPushEndpoint, validPushKeys } from './rules'
import { sendPush } from './sender'
import type { NotificationModel } from './model'

export async function deliverNotification(id: string, now = new Date()) {
    const lease = crypto.randomUUID()
    const jobs = await db.execute(sql`WITH claimed AS (
        UPDATE notification_deliveries SET lease = ${lease}, attempts = attempts + 1,
            available_at = ${new Date(now.getTime() + 60_000).toISOString()}
        WHERE id = ${id} AND delivered_at IS NULL AND attempts < 5 AND available_at <= ${now.toISOString()}
            AND occurrence > ${new Date(now.getTime() - 15 * 60_000).toISOString()}
        RETURNING *
    ) SELECT d.*, p.subscription, e.name, e.slug, e.rrule, e.start_time, g.slug AS group_slug,
        coalesce(g.name, g.cached_name, 'Group') AS group_name,
        (e.visibility = 'PUBLIC' AND g.visibility <> 'PRIVATE' AND g.moderation <> 'HIDDEN' AND g.show_shifts
          AND (u.banned_at IS NULL OR u.ban_expires_at <= ${now.toISOString()})
          AND EXISTS (SELECT 1 FROM notification_watches w WHERE w.user_id = p.user_id AND w.group_id = g.id
              AND (w.event_id IS NULL OR w.event_id = e.event_id))) AS allowed
    FROM claimed d JOIN push_subscriptions p ON p.id = d.subscription_id
        JOIN users u ON u.id = p.user_id JOIN events e ON e.event_id = d.event_id JOIN groups g ON g.id = e.group_id`)
    const job = databaseRows(jobs)[0]
    if (!job) return
    const scope = and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.lease, lease))
    const occurrenceDate = job.occurrence instanceof Date ? job.occurrence : new Date(String(job.occurrence))
    const startTime = job.start_time instanceof Date ? job.start_time : new Date(String(job.start_time))
    const stillScheduled = occurrenceStartsBetween(String(job.rrule), startTime, occurrenceDate, occurrenceDate, 1).length > 0
    if (!job.allowed || !stillScheduled) {
        await db.update(notificationDeliveries).set({ deliveredAt: now }).where(scope)
        return
    }
    let response: Response | null = null
    try {
        const value = await decryptSecret(String(job.subscription))
        if (!value) throw new Error('Subscription encryption key changed')
        const subscription = JSON.parse(value) as NotificationModel.subscription
        if (!validPushEndpoint(subscription.endpoint) || !validPushKeys(subscription.keys)) throw new Error('Invalid subscription')
        const occurrence = new Date(String(job.occurrence)).toISOString()
        response = await sendPush(subscription, {
            title: String(job.group_name), body: `${job.name} is starting soon.`,
            tag: `${job.event_id}:${occurrence}`,
            url: `${FRONTEND_URL}/g/${encodeURIComponent(String(job.group_slug))}/shift/${encodeURIComponent(String(job.slug))}`
        })
        if (response.status === 404 || response.status === 410) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, String(job.subscription_id)))
            return
        }
        if (response.ok) {
            await db.update(notificationDeliveries).set({ deliveredAt: now }).where(scope)
            return
        }
        // Permanent provider rejection should not keep retrying a revoked VAPID key or bad payload.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            await db.update(notificationDeliveries).set({ attempts: 5 }).where(scope)
            console.warn('[notifications] push rejected', response.status)
            return
        }
    } catch {
        console.warn('[notifications] push delivery will be retried')
    }
    await db.update(notificationDeliveries).set({ availableAt: new Date(now.getTime() + retryDelay(Number(job.attempts), response?.headers.get('retry-after') ?? null) * 1000) }).where(scope)
}
