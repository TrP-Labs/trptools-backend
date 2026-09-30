import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import webpush from 'web-push'
import { and, eq } from 'drizzle-orm'

// Real storage and HTTP/authentication; only the external push provider is replaced.
// Refuse to run this destructive fixture cleanup against a non-test database.
if (!process.env.DATABASE_URL?.endsWith('/trptools_engagement_test')) throw new Error('Use the isolated trptools_engagement_test database')
const vapid = webpush.generateVAPIDKeys()
process.env.VAPID_PUBLIC_KEY = vapid.publicKey
process.env.VAPID_PRIVATE_KEY = vapid.privateKey
process.env.VAPID_SUBJECT = 'mailto:test@example.com'
process.env.BACKGROUND_JOB_TOKEN = 'test-background-token'
process.env.FRONTEND_URL = 'http://localhost:5173'
let providerStatus = 201
let sent = 0
mock.module('../src/notifications/sender', () => ({
    sendPush: async () => { sent++; return new Response(null, { status: providerStatus, headers: { 'retry-after': '60' } }) }
}))
const { app } = await import('../src/index')
const { default: db, client } = await import('../src/db')
const { users, groups, events, sessions, pushSubscriptions, notificationDeliveries } = await import('../src/db/schema')
const { hashToken } = await import('../src/utils/sessionVerifier')
const { planNotification } = await import('../src/notifications/scheduler')
const { deliverNotification } = await import('../src/notifications/delivery')
const { decryptSecret } = await import('../src/utils/crypto')
const id = crypto.randomUUID(), other = crypto.randomUUID(), group = crypto.randomUUID(), hidden = crypto.randomUUID(), event = crypto.randomUUID()
const token = crypto.randomUUID(), otherToken = crypto.randomUUID()
const start = new Date(Date.now() + 5 * 60_000)
const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', ecdh.publicKey)).toString('base64url')
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID(), keys: { p256dh, auth: Buffer.alloc(16, 1).toString('base64url') } }
async function call(path: string, method = 'GET', body?: unknown, cookie: string | null = token, origin = 'http://localhost:5173') {
    const response = await app.handle(new Request('http://localhost:3001' + path, { method,
        headers: { ...(cookie ? { cookie: `access_token=${cookie}` } : {}), origin, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) }))
    const raw = await response.text()
    return { status: response.status, data: raw.startsWith('{') || raw.startsWith('[') ? JSON.parse(raw) : raw }
}
beforeAll(async () => {
    await db.insert(users).values([{ id, robloxId: Date.now(), cachedAt: new Date() }, { id: other, robloxId: Date.now() + 1, cachedAt: new Date() }])
    await db.insert(sessions).values([{ sessionId: hashToken(token), userId: id, expiresAt: new Date(Date.now() + 86400_000) }, { sessionId: hashToken(otherToken), userId: other, expiresAt: new Date(Date.now() + 86400_000) }])
    await db.insert(groups).values([{ id: group, robloxId: 'fixture-' + group, slug: 'fixture-' + group, visibility: 'PUBLIC', cachedAt: new Date(), cachedName: 'Test Transit' }, { id: hidden, robloxId: 'fixture-' + hidden, slug: 'fixture-' + hidden, visibility: 'PRIVATE', cachedAt: new Date() }])
    await db.insert(events).values({ eventId: event, groupId: group, name: 'Test service', slug: 'test-service', startTime: start, rrule: 'FREQ=DAILY;COUNT=1' })
})
afterAll(async () => {
    await db.delete(groups).where(eq(groups.id, group)); await db.delete(groups).where(eq(groups.id, hidden))
    await db.delete(users).where(eq(users.id, id)); await db.delete(users).where(eq(users.id, other))
    await client?.end()
})
test('following requires authentication, rejects CSRF and private targets, and is idempotent', async () => {
    const path = '/users/me/follows/' + group
    expect((await call(path, 'PUT', { following: true }, null)).status).toBe(401)
    expect((await call(path, 'PUT', { following: true }, token, 'https://evil.example')).status).toBe(403)
    expect((await call('/users/me/follows/' + hidden, 'PUT', { following: true })).status).toBe(404)
    expect((await call(path, 'PUT', { following: true })).status).toBe(200)
    expect((await call(path, 'PUT', { following: true })).status).toBe(200)
    expect((await call('/users/me/follows')).data).toHaveLength(1)
    expect((await call('/users/me/follows', 'GET', undefined, otherToken)).data).toEqual([])
    expect((await call('/dashboard/shifts')).data.occurrences[0].eventId).toBe(event)
})
test('push subscription validates provider URLs and curve keys, encrypts credentials, and isolates removal', async () => {
    expect((await call('/notifications/subscription', 'PUT', { ...subscription, endpoint: 'http://127.0.0.1/secret' })).status).toBe(400)
    expect((await call('/notifications/subscription', 'PUT', { ...subscription, keys: { ...subscription.keys, p256dh: 'bad' } })).status).toBe(400)
    const badPoint = new Uint8Array(65); badPoint[0] = 4
    expect((await call('/notifications/subscription', 'PUT', { ...subscription, keys: { ...subscription.keys, p256dh: Buffer.from(badPoint).toString('base64url') } })).status).toBe(400)
    expect((await call('/notifications/subscription', 'PUT', subscription)).status).toBe(200)
    expect((await call('/notifications/subscription', 'PUT', subscription)).status).toBe(200)
    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.subscription).not.toContain(subscription.endpoint)
    expect(JSON.parse((await decryptSecret(rows[0]!.subscription))!)).toEqual(subscription)
    expect((await call('/notifications/subscription', 'DELETE', { endpoint: subscription.endpoint }, otherToken)).status).toBe(200)
    expect((await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, id)))).toHaveLength(1)
})
test('watch scope is checked and overlapping group and shift watches produce one delivery', async () => {
    expect((await call('/notifications/groups/' + hidden, 'PUT', { enabled: true })).status).toBe(404)
    expect((await call('/notifications/groups/' + hidden, 'PUT', { enabled: true, eventId: event })).status).toBe(404)
    expect((await call('/notifications/groups/' + group, 'PUT', { enabled: true })).status).toBe(200)
    expect((await call('/notifications/groups/' + group, 'PUT', { enabled: true, eventId: event })).status).toBe(200)
    const state = await call('/notifications/groups/' + group + '?eventId=' + event)
    expect(state.data).toMatchObject({ following: true, groupReminder: true, shiftReminder: true, deviceCount: 1 })
    await Promise.all([planNotification(event), planNotification(event)])
    expect(await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, event))).toHaveLength(1)
})
test('a group becoming private and an edited recurrence both cancel queued reminders', async () => {
    const [job] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, event))
    await db.update(groups).set({ visibility: 'PRIVATE' }).where(eq(groups.id, group))
    await deliverNotification(job!.id)
    expect(sent).toBe(0)
    await db.update(groups).set({ visibility: 'PUBLIC' }).where(eq(groups.id, group))
    await db.update(notificationDeliveries).set({ deliveredAt: null, availableAt: new Date() }).where(eq(notificationDeliveries.id, job!.id))
    await db.update(events).set({ startTime: new Date(start.getTime() + 86400_000) }).where(eq(events.eventId, event))
    await deliverNotification(job!.id)
    expect(sent).toBe(0)
    await db.update(events).set({ startTime: start }).where(eq(events.eventId, event))
    await db.update(notificationDeliveries).set({ deliveredAt: null, attempts: 0, availableAt: new Date() }).where(eq(notificationDeliveries.id, job!.id))
})
test('concurrent delivery leases send once; retries respect provider backoff; expired devices are removed', async () => {
    const [job] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, event))
    providerStatus = 429
    await Promise.all([deliverNotification(job!.id), deliverNotification(job!.id)])
    expect(sent).toBe(1)
    const [retry] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, job!.id))
    expect(retry!.attempts).toBe(1)
    expect(retry!.deliveredAt).toBeNull()
    expect(retry!.availableAt.getTime()).toBeGreaterThan(Date.now() + 50_000)
    await db.update(notificationDeliveries).set({ availableAt: new Date() }).where(eq(notificationDeliveries.id, job!.id))
    providerStatus = 410
    await deliverNotification(job!.id)
    expect(sent).toBe(2)
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, id))).toEqual([])
})
test('internal jobs refuse ordinary sessions and malformed subscription bodies', async () => {
    expect((await call('/background/notification/plan/' + event, 'POST')).status).toBe(401)
    expect((await call('/notifications/subscription', 'PUT', {})).status).toBe(400)
    expect((await call('/notifications/groups/not-a-uuid', 'PUT', { enabled: true })).status).toBe(400)
})
