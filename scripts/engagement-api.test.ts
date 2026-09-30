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
const { planNotification, drainNotificationBatch } = await import('../src/notifications/scheduler')
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
    const home = await call('/dashboard/home?mode=user')
    expect(home.status).toBe(200)
    expect(home.data.dashboard.mode).toBe('user')
    expect(home.data.dashboard.groups[0].permissions).toBe(0)
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

test('homepage layouts round-trip per account and reject privilege-shaped or duplicate widgets', async () => {
    const homeLayout = { user: [{ id: 'today', width: 2 }, { id: 'my-shifts', width: 1 }], host: [{ id: 'reviews', width: 2 }] }
    expect((await call('/users/me/preferences', 'PATCH', { homeLayout, homeMode: 'host' })).status).toBe(200)
    expect((await call('/users/me/preferences')).data).toMatchObject({ homeLayout, homeMode: 'host' })
    expect((await call('/auth/session')).data.user.homeLayout).toEqual(homeLayout)
    expect((await call('/users/me/preferences', 'PATCH', { homeLayout: { ...homeLayout, user: [{ id: 'reviews', width: 1 }] } })).status).toBe(400)
    expect((await call('/users/me/preferences', 'PATCH', { homeLayout: { ...homeLayout, user: [{ id: 'today', width: 1 }, { id: 'today', width: 1 }] } })).status).toBe(400)
    expect((await call('/users/me/preferences', 'PATCH', { homeLayout: { ...homeLayout, user: [{ id: 'next', width: 3 }] } })).status).toBe(400)
    expect((await call('/users/me/preferences', 'GET', undefined, otherToken)).data.homeLayout).not.toEqual(homeLayout)
    // Host mode is a view preference, never a permission grant.
    expect((await call('/dashboard/home?mode=host')).data.dashboard.groups).toEqual([])
})

test('join links have fixed destinations, respect visibility and grants, and redirects are opt-in per account', async () => {
    const slug = 'fixture-' + group
    expect((await call(`/public/groups/${slug}/join/roblox`, 'GET', undefined, null)).data.url).toBe(`https://www.roblox.com/groups/fixture-${group}`)
    expect((await call(`/public/groups/${slug}/join/discord`, 'GET', undefined, null)).status).toBe(404)
    expect((await call(`/public/groups/fixture-${hidden}/join/roblox`, 'GET', undefined, null)).status).toBe(404)
    expect((await call('/groups/' + group, 'PATCH', { discordInvite: 'abcdef' })).status).toBe(403)
    await db.update(users).set({ siteRank: 'admin' }).where(eq(users.id, id))
    await db.update(sessions).set({ adminMode: true }).where(eq(sessions.sessionId, hashToken(token)))
    expect((await call('/dashboard/home?mode=host')).status).toBe(200)
    expect((await call('/groups/' + group, 'PATCH', { discordInvite: 'https://evil.example/abc' })).status).toBe(400)
    expect((await call('/groups/' + group, 'PATCH', { discordInvite: 'https://discord.com/invite/abcdef' })).status).toBe(200)
    expect((await call(`/public/groups/${slug}/join/discord`, 'GET', undefined, null)).data.url).toBe('https://discord.gg/abcdef')
    expect((await call('/groups/' + group, 'PATCH', { robloxJoinEnabled: false })).status).toBe(200)
    expect((await call(`/public/groups/${slug}/join/roblox`, 'GET', undefined, null)).status).toBe(404)
    expect((await call('/users/me/preferences')).data.instantRedirects).toBe(false)
    expect((await call('/users/me/preferences', 'PATCH', { instantRedirects: true })).status).toBe(200)
    expect((await call('/auth/session')).data.user.instantRedirects).toBe(true)
    expect((await call('/users/me/preferences', 'GET', undefined, otherToken)).data.instantRedirects).toBe(false)
    await db.update(users).set({ siteRank: 'user' }).where(eq(users.id, id))
    await db.update(sessions).set({ adminMode: false }).where(eq(sessions.sessionId, hashToken(token)))
})

test('anonymous counters validate origins and published targets and aggregate exactly once across replicas', async () => {
    const { collectStatistics, aggregateStatistics } = await import('../src/statistics/collector')
    const { statisticsDaily, statisticsEvents } = await import('../src/db/schema')
    const metric = { id: crypto.randomUUID(), groupId: group, kind: 'group_view' as const }
    expect((await call('/statistics/events', 'POST', { events: [metric] }, null, 'https://evil.example')).status).toBe(403)
    expect((await call('/statistics/events', 'POST', { events: [{ ...metric, kind: 'made_up' }] }, null)).status).toBe(400)
    expect((await call('/statistics/events', 'POST', { events: Array(9).fill(metric) }, null)).status).toBe(400)
    expect((await call('/statistics/events', 'POST', { events: [metric] }, null)).status).toBe(202)
    await collectStatistics({ events: [metric, { ...metric, id: crypto.randomUUID(), groupId: hidden }, { ...metric, id: crypto.randomUUID(), kind: 'route_view', targetId: event }] })
    expect((await db.select().from(statisticsEvents).where(eq(statisticsEvents.groupId, hidden)))).toHaveLength(0)
    await Promise.all([aggregateStatistics(), aggregateStatistics()])
    const rows = await db.select().from(statisticsDaily).where(eq(statisticsDaily.groupId, group))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(1)
    await aggregateStatistics()
    expect((await db.select().from(statisticsDaily).where(eq(statisticsDaily.groupId, group)))[0]!.count).toBe(1)
    expect((await call('/statistics/groups/' + group)).status).toBe(403)
    expect((await call('/statistics/groups/' + group, 'GET', undefined, null)).status).toBe(401)
    await db.update(users).set({ siteRank: 'admin' }).where(eq(users.id, id))
    // Admin standing alone never grants access.
    expect((await call('/statistics/groups/' + group)).status).toBe(403)
    await db.update(sessions).set({ adminMode: true }).where(eq(sessions.sessionId, hashToken(token)))
    const result = await call('/statistics/groups/' + group + '?days=7')
    expect(result.status).toBe(200)
    expect(result.data.totals.groupViews).toBe(1)
    expect(result.data.daily).toHaveLength(7)
    expect(result.data.followers).toBe(1)
    expect((await call('/statistics/groups/' + group + '?days=999')).status).toBe(400)
    await db.update(users).set({ siteRank: 'user' }).where(eq(users.id, id))
    await db.update(sessions).set({ adminMode: false }).where(eq(sessions.sessionId, hashToken(token)))
})

test('route votes stay aggregate and scoped while built-ins use the shared preference contract', async () => {
    const { routes, routePreferences, globalRoutePreferences } = await import('../src/db/schema')
    const { groupStatistics } = await import('../src/statistics/service')
    const { collectStatistics, aggregateStatistics } = await import('../src/statistics/collector')
    const custom = crypto.randomUUID(), builtIn = crypto.randomUUID(), secret = crypto.randomUUID()
    const voters = Array.from({ length: 5 }, () => crypto.randomUUID())
    try {
        await db.insert(users).values(voters.map((id, i) => ({ id, robloxId: Date.now() + 100 + i })))
        await db.insert(routes).values([{ id: custom, groupId: group, name: '15', slug: '15' }, { id: builtIn, groupId: group, name: '6', slug: '6', builtIn: true }, { id: secret, groupId: group, name: 'Secret', slug: 'secret', visibility: 'PRIVATE' }])
        await db.insert(routePreferences).values(voters.map((userId, i) => ({ userId, routeId: custom, preference: i < 3 ? 'FAVORITE' as const : 'DISLIKE' as const })))
        await db.insert(globalRoutePreferences).values(voters.map(userId => ({ userId, routeName: '6', preference: 'FAVORITE' as const })))
        await collectStatistics({ events: [{ id: crypto.randomUUID(), groupId: group, kind: 'route_view', targetId: custom }, { id: crypto.randomUUID(), groupId: group, kind: 'route_view', targetId: secret }, { id: crypto.randomUUID(), groupId: hidden, kind: 'route_view', targetId: custom }] })
        await aggregateStatistics()
        const data = await groupStatistics(group, 7, { authenticated: true, user: { userId: id, robloxId: 1, siteRank: 'admin', adminMode: true } })
        expect(data.routes.find(r => r.id === custom)).toMatchObject({ votes: 5, favorites: 3, dislikes: 2, favoritePercent: 60, views: 1 })
        expect(data.routes.find(r => r.id === builtIn)).toMatchObject({ votes: 5, favoritePercent: 100, builtIn: true })
        expect(data.routes.find(r => r.id === secret)).toMatchObject({ votes: 0, favoritePercent: null, favorites: null, views: 0 })
    } finally { for (const userId of voters) await db.delete(users).where(eq(users.id, userId)) }
})

test('device caps withstand concurrent registration and reassignment isolates ownership', async () => {
    const devices = Array.from({ length: 11 }, () => ({ ...subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID() }))
    const results = await Promise.all(devices.map(device => call('/notifications/subscription', 'PUT', device)))
    expect(results.filter(result => result.status === 200)).toHaveLength(10)
    expect(results.filter(result => result.status === 409)).toHaveLength(1)
    const accepted = devices[results.findIndex(result => result.status === 200)]!
    expect((await call('/notifications/subscription', 'PUT', accepted)).status).toBe(200)
    const [device] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpointHash, hashToken(accepted.endpoint)))
    const [oldJob] = await db.insert(notificationDeliveries).values({ subscriptionId: device!.id, eventId: event, occurrence: start }).returning()
    expect((await call('/notifications/subscription', 'PUT', accepted, otherToken)).status).toBe(200)
    const before = sent
    await deliverNotification(oldJob!.id)
    expect(sent).toBe(before)
    expect((await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, oldJob!.id)))[0]!.deliveredAt).not.toBeNull()
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, other))).toHaveLength(1)
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, id))).toHaveLength(9)
})


test('late watches and devices replan an imminent shift, and drains are bounded without dropping the remainder', async () => {
    await call('/notifications/groups/' + group, 'PUT', { enabled: false })
    await call('/notifications/groups/' + group, 'PUT', { enabled: false, eventId: event })
    const lateEvent = crypto.randomUUID()
    await db.insert(events).values({ eventId: lateEvent, groupId: group, name: 'Late reminder', slug: 'late-reminder', startTime: start, rrule: 'FREQ=DAILY;COUNT=1', notificationAt: null })
    expect((await call('/notifications/groups/' + group, 'PUT', { enabled: true, eventId: lateEvent }, otherToken)).status).toBe(200)
    expect((await db.select().from(events).where(eq(events.eventId, lateEvent)))[0]!.notificationAt).not.toBeNull()
    await planNotification(lateEvent)
    expect(await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, lateEvent))).toHaveLength(1)
    await db.update(events).set({ notificationAt: null }).where(eq(events.eventId, lateEvent))
    const lateDevice = { ...subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID() }
    expect((await call('/notifications/subscription', 'PUT', lateDevice, otherToken)).status).toBe(200)
    expect((await db.select().from(events).where(eq(events.eventId, lateEvent)))[0]!.notificationAt).not.toBeNull()
    await planNotification(lateEvent)
    const jobs = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, lateEvent))
    expect(jobs).toHaveLength(2)
    // Restrict this drain test to its own fixtures; no unrelated jobs are deleted.
    await db.update(notificationDeliveries).set({ deliveredAt: new Date() }).where(eq(notificationDeliveries.eventId, event))
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.eventId, lateEvent))
    await db.insert(notificationDeliveries).values(Array.from({ length: 30 }, (_, i) => ({ subscriptionId: jobs[0]!.subscriptionId, eventId: lateEvent, occurrence: new Date(start.getTime() + i * 1000) })))
    const delivered = new Set<string>()
    const dispatch = async (_kind: 'plan' | 'send', jobId: string) => {
        expect(delivered.has(jobId)).toBe(false)
        delivered.add(jobId)
        await db.update(notificationDeliveries).set({ deliveredAt: new Date() }).where(eq(notificationDeliveries.id, jobId))
    }
    expect(await drainNotificationBatch(dispatch)).toBe(true)
    expect(delivered.size).toBe(25)
    expect(await drainNotificationBatch(dispatch)).toBe(false)
    expect(delivered.size).toBe(30)
})
