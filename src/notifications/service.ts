import { status } from 'elysia'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import db from '../db'
import { databaseRows } from '../db/rows'
import { events, groupFollows, groups, notificationWatches, pushSubscriptions } from '../db/schema'
import { requireUser } from '../utils/authPlugin'
import type { session } from '../utils/sessionVerifier'
import { env } from '../utils/env'
import { encryptSecret } from '../utils/crypto'
import { hashToken } from '../utils/sessionVerifier'
import { validPushEndpoint, validPushKeys } from './rules'
import { databaseLimitReached } from '../utils/databaseLimit'
import type { NotificationModel } from './model'

export const notificationsConfigured = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT)

export abstract class Notifications {
    static async state(groupId: string, eventId: string | undefined, session: session): Promise<NotificationModel.state> {
        const user = requireUser(session)
        const rows = await db.execute(sql`SELECT
            EXISTS (SELECT 1 FROM group_follows WHERE user_id = ${user.userId} AND group_id = ${groupId}) AS following,
            EXISTS (SELECT 1 FROM notification_watches WHERE user_id = ${user.userId} AND group_id = ${groupId} AND event_id IS NULL) AS group_reminder,
            EXISTS (SELECT 1 FROM notification_watches WHERE user_id = ${user.userId} AND group_id = ${groupId} AND event_id = ${eventId ?? null}) AS shift_reminder,
            (SELECT count(*)::int FROM push_subscriptions WHERE user_id = ${user.userId}) AS device_count`)
        const row = databaseRows(rows)[0]!
        return { following: Boolean(row.following), groupReminder: Boolean(row.group_reminder), shiftReminder: Boolean(row.shift_reminder),
            deviceCount: Number(row.device_count), publicKey: notificationsConfigured() ? env.VAPID_PUBLIC_KEY : null }
    }

    static async watch(groupId: string, body: NotificationModel.watchBody, session: session) {
        const user = requireUser(session)
        const scope = and(eq(notificationWatches.userId, user.userId), eq(notificationWatches.groupId, groupId),
            body.eventId ? eq(notificationWatches.eventId, body.eventId) : isNull(notificationWatches.eventId))
        if (!body.enabled) {
            await db.delete(notificationWatches).where(scope)
            return 'Success' as const
        }
        if (!notificationsConfigured()) throw status(503, 'Service Unavailable')
        const [group] = await db.select({ id: groups.id }).from(groups).where(and(
            eq(groups.id, groupId), ne(groups.visibility, 'PRIVATE'), ne(groups.moderation, 'HIDDEN'), eq(groups.showShifts, true)
        )).limit(1)
        if (!group) throw status(404, 'Not Found')
        if (body.eventId) {
            const [event] = await db.select({ id: events.eventId }).from(events).where(and(
                eq(events.eventId, body.eventId), eq(events.groupId, groupId), eq(events.visibility, 'PUBLIC')
            )).limit(1)
            if (!event) throw status(404, 'Not Found')
        }
        try {
            await db.insert(notificationWatches).values({ userId: user.userId, groupId, eventId: body.eventId ?? null }).onConflictDoNothing()
        } catch (error) {
            if (databaseLimitReached(error, 'notification watch limit')) throw status(409, 'Conflict')
            throw error
        }
        return 'Success' as const
    }

    static async subscribe(body: NotificationModel.subscription, session: session) {
        const user = requireUser(session)
        if (!notificationsConfigured()) throw status(503, 'Service Unavailable')
        if (!validPushEndpoint(body.endpoint) || !validPushKeys(body.keys)) throw status(400, 'Bad Request')
        try {
            const bytes = Uint8Array.from(atob(body.keys.p256dh.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
            await crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
        } catch { throw status(400, 'Bad Request') }
        const subscription = await encryptSecret(JSON.stringify(body))
        try {
            // A browser signed into another account must stop receiving the old account's reminders.
            await db.insert(pushSubscriptions).values({ userId: user.userId, endpointHash: hashToken(body.endpoint), subscription })
                .onConflictDoUpdate({ target: pushSubscriptions.endpointHash, set: { userId: user.userId, subscription, updatedAt: new Date() } })
        } catch (error) {
            if (databaseLimitReached(error, 'push device limit')) throw status(409, 'Conflict')
            throw error
        }
        return 'Success' as const
    }

    static async unsubscribe(endpoint: string, session: session) {
        const user = requireUser(session)
        await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, user.userId), eq(pushSubscriptions.endpointHash, hashToken(endpoint))))
        return 'Success' as const
    }
}
