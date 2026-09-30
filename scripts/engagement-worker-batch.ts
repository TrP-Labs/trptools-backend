import assert from 'node:assert/strict'
import { and, eq, inArray } from 'drizzle-orm'
if (!process.env.DATABASE_URL?.endsWith('/trptools_engagement_test')) throw new Error('Use isolated test storage')
const { default: db, client } = await import('../src/db')
const { events, notificationDeliveries } = await import('../src/db/schema')
const { planNotification } = await import('../src/notifications/scheduler')
const fixture = await Bun.file('/tmp/trptools-engagement-fixture.json').json()
const origin = 'http://localhost:54002', ids = Array.from({ length: 30 }, () => crypto.randomUUID())
const headers = { cookie: `access_token=${fixture.token}`, origin: 'http://localhost:54000', 'content-type': 'application/json' }
try {
    await db.insert(events).values(ids.map(eventId => ({ eventId, groupId: fixture.groupId, name: 'Worker batch fixture', slug: eventId, startTime: new Date(Math.floor((Date.now() + 5 * 60_000) / 1000) * 1000), rrule: 'FREQ=DAILY;COUNT=1' })))
    const enabled = await fetch(`${origin}/notifications/groups/${fixture.groupId}`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })
    assert.equal(enabled.status, 200)
    await Promise.all(ids.map(id => planNotification(id)))
    const jobs = await db.select().from(notificationDeliveries).where(inArray(notificationDeliveries.eventId, ids))
    assert.equal(jobs.length, 30, 'use exactly one owned Worker-encrypted device fixture')
    const before = (await (await fetch(origin + '/__test/push-count')).json()).sent
    const drains = await Promise.all([0, 1].map(() => fetch(origin + '/background/notifications/drain', { method: 'POST', headers: { authorization: 'Bearer engagement-local-test-only' } })))
    for (const response of drains) { assert.equal(response.status, 200); await response.text() }
    let delivered = 0
    for (let attempt = 0; attempt < 30; attempt++) {
        delivered = (await db.select().from(notificationDeliveries).where(inArray(notificationDeliveries.eventId, ids))).filter(job => job.deliveredAt).length
        if (delivered === 30) break
        await Bun.sleep(200)
    }
    assert.equal(delivered, 30, 'waitUntil continuation must drain the remaining five')
    assert.equal((await (await fetch(origin + '/__test/push-count')).json()).sent - before, 30, 'concurrent drains must not duplicate provider sends')
    console.log('Worker batch regression passed: 30 real encrypted sends, concurrent drains, unique leases and waitUntil continuation beyond 25.')
} finally {
    await fetch(`${origin}/notifications/groups/${fixture.groupId}`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) })
    await db.delete(events).where(and(eq(events.groupId, fixture.groupId), inArray(events.eventId, ids)))
    await client?.end()
}
