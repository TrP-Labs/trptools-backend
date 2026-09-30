import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
if (!process.env.DATABASE_URL?.endsWith('/trptools_engagement_test')) throw new Error('Use isolated test storage')
const { default: db, client } = await import('../src/db')
const { events, notificationDeliveries, pushSubscriptions } = await import('../src/db/schema')
const fixture = await Bun.file('/tmp/trptools-engagement-fixture.json').json()
const origin = 'http://localhost:54002', groupId = fixture.groupId, eventId = crypto.randomUUID()
const startTime = new Date(Math.floor((Date.now() + 5 * 60_000) / 1000) * 1000)
let subscriptionId: string | undefined
const headers = { cookie: `access_token=${fixture.token}`, origin: 'http://localhost:54000', 'content-type': 'application/json' }
async function request(path: string, body?: unknown, trusted = false) {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: trusted ? { authorization: 'Bearer engagement-local-test-only' } : headers, body: body === undefined ? undefined : JSON.stringify(body) })
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    return response
}
try {
    await db.delete(events).where(and(eq(events.groupId, groupId), eq(events.name, 'Worker reminder fixture')))
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, fixture.userId))
    await db.insert(events).values({ eventId, groupId, name: 'Worker reminder fixture', slug: 'worker-reminder-' + eventId, startTime, rrule: 'FREQ=DAILY;COUNT=1' })
    const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', ecdh.publicKey)).toString('base64url')
    const sub = await fetch(origin + '/notifications/subscription', { method: 'PUT', headers, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomUUID(), keys: { p256dh, auth: Buffer.alloc(16, 1).toString('base64url') } }) })
    assert.equal(sub.status, 200)
    const watch = await fetch(origin + '/notifications/groups/' + groupId, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, eventId }) })
    assert.equal(watch.status, 200)
    await request('/background/notification/plan/' + eventId, {}, true)
    const [job] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId))
    assert.ok(job); subscriptionId = job.subscriptionId
    const before = (await (await fetch(origin + '/__test/push-count')).json()).sent
    await request('/background/notifications/drain', {}, true)
    const after = (await (await fetch(origin + '/__test/push-count')).json()).sent
    assert.equal(after - before, 1, 'real web-push encryption and VAPID signing must reach the mocked provider')
    const [delivered] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, job.id))
    assert.ok(delivered!.deliveredAt)
    await request('/background/notifications/drain', {}, true)
    assert.equal((await (await fetch(origin + '/__test/push-count')).json()).sent, after)
    const unauthorized = await fetch(origin + '/background/notifications/drain', { method: 'POST', headers })
    assert.equal(unauthorized.status, 401)
    // Keep one encrypted fixture job for the sampler; it resets only this job between runs.
    await Bun.write('/tmp/trptools-engagement-push-fixture.json', JSON.stringify({ eventId, jobId: job.id, subscriptionId, groupId }))
    console.log('Worker notification plan, drain, encryption, provider handoff, deduplication and authentication passed.')
} catch (error) {
    await db.delete(events).where(eq(events.eventId, eventId))
    if (subscriptionId) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId))
    throw error
} finally { await client?.end() }
