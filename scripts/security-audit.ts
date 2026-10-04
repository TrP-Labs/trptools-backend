import assert from 'node:assert/strict'
import { eq, inArray, sql } from 'drizzle-orm'

// Never run this against an operator's database or Redis instance.
const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null
if (databaseUrl?.hostname !== '127.0.0.1' || databaseUrl.port !== '54379' || databaseUrl.pathname !== '/trptools_audit_test' || process.env.REDIS_URL !== 'redis://127.0.0.1:54380') {
    throw new Error('Use the isolated audit database on 54379 and Redis on 54380')
}
Object.assign(process.env, { NODE_ENV: 'test', ROBLOX_API_KEY: '', ROBLOX_CLIENT_ID: '', ROBLOX_CLIENT_SECRET: '',
    ENCRYPTION_KEY: 'audit-test-only', FRONTEND_URL: 'http://localhost:54382', BASE_URL: 'http://localhost:54381',
    SITE_ADMINS: '', BOT_SERVICE_TOKEN: '', BOT_WORKER_URL: '', BOT_WORKER_SYNC_TOKEN: '',
    DISCORD_APP_ID: '', DISCORD_BOT_TOKEN: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
    S3_ENDPOINT: 'http://127.0.0.1:54383', S3_ACCESS_KEY: 'audit', S3_SECRET_KEY: 'audit', S3_PUBLIC_URL: 'http://127.0.0.1:54383/audit' })
const objectRequests: string[] = []
const storage = Bun.serve({ hostname: '127.0.0.1', port: 54383, fetch(request) { objectRequests.push(request.method); return new Response('', { status: 200 }) } })
const localFetch = fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return localFetch(input, init)
    throw new Error('External providers are disabled in the audit fixture')
}) as typeof fetch
const { app } = await import('../src/index')
const { default: db, client } = await import('../src/db')
const { groups, users, sessions, apiKeys, routes, depots, events, signupSheets, signupSlots, shiftSignups, media, reports } = await import('../src/db/schema')
const { dataRedis } = await import('../src/utils/redis')
const { hashToken, ResolveSession } = await import('../src/utils/sessionVerifier')
const { PERM } = await import('../src/utils/permissions')
const groupId = crypto.randomUUID(), ownerId = crypto.randomUUID(), token = crypto.randomUUID(), key = crypto.randomUUID()
const actors = Array.from({ length: 12 }, () => crypto.randomUUID())
const actorTokens = actors.map(() => crypto.randomUUID())
const occurrence = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 3_600_000)
const request = (path: string, method = 'GET', body?: unknown, credential: 'key' | 'cookie' | 'anonymous' = 'key', callerToken = token) => app.handle(new Request('http://localhost:54381' + path, {
    method, headers: { origin: 'http://localhost:54382', ...(credential === 'key' ? { authorization: `Bearer ${key}` } : credential === 'cookie' ? { cookie: `access_token=${callerToken}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
}))
try {
    await db.insert(groups).values({ id: groupId, robloxId: groupId, slug: 'audit-' + groupId, cachedName: 'Audit group', cachedAt: new Date(), visibility: 'PUBLIC' })
    await db.insert(users).values([{ id: ownerId, robloxId: 99990001, cachedUsername: 'AuditOwner', cachedAt: new Date(), siteRank: 'admin' },
        ...actors.map((id, index) => ({ id, robloxId: 99990100 + index, cachedUsername: 'Actor' + index, cachedAt: new Date(), discordId: 'audit-discord-' + index }))])
    await db.insert(sessions).values({ userId: ownerId, sessionId: hashToken(token), expiresAt: new Date(Date.now() + 86400000), adminMode: true })
    await db.insert(sessions).values(actors.map((userId, index) => ({ userId, sessionId: hashToken(actorTokens[index]!), expiresAt: new Date(Date.now() + 86400000) })))
    await db.insert(apiKeys).values({ userId: ownerId, token: hashToken(key), prefix: 'audit', scopes: 'groups:read' })
    await dataRedis.set(`perm:${groupId}:${ownerId}`, `3:255:${PERM.ADMINISTRATOR}:`, 'EX', 3600)
    await Promise.all(actors.map(userId => dataRedis.set(`perm:${groupId}:${userId}`, '0:50:0:', 'EX', 3600)))
    assert.equal((await request('/groups/' + groupId, 'PATCH', { name: 'Unauthorized change' })).status, 403)
    assert.equal((await request('/auth/keys', 'POST', { name: 'Escalation', scopes: ['dispatch:write'] })).status, 403)
    assert.equal((await request('/auth/logout/all', 'POST')).status, 403)
    assert.equal((await request('/routes?groupId=' + groupId)).status, 403)
    assert.equal((await request('/groups/' + groupId)).status, 200)
    assert.equal((await request('/groups/' + groupId)).headers.get('cache-control'), 'private, no-store')
    assert.equal((await request('/groups/' + groupId, 'PATCH', { name: 'Audit group' }, 'cookie')).status, 200)
    console.log('PASS: real HTTP scope enforcement, cookie access and private caching')

    const [route] = await db.insert(routes).values({ groupId, name: 'Audit route', slug: 'audit' }).returning()
    const [depot] = await db.insert(depots).values({ groupId, name: 'Audit depot', slug: 'audit', number: 1 }).returning()
    for (const change of [{ visibility: 'PRIVATE' as const }, { visibility: 'PUBLIC' as const, moderation: 'HIDDEN' as const }]) {
        await db.update(groups).set(change).where(eq(groups.id, groupId))
        for (const path of ['/routes/' + route!.id, '/depots/' + depot!.id]) assert.equal((await request(path, 'GET', undefined, 'anonymous')).status, 404)
    }
    await db.update(groups).set({ visibility: 'PUBLIC', moderation: 'VISIBLE' }).where(eq(groups.id, groupId))
    for (const path of ['/routes/' + route!.id, '/depots/' + depot!.id]) assert.equal((await request(path, 'GET', undefined, 'anonymous')).status, 200)
    console.log('PASS: direct route/depot privacy and moderation gates')

    const [event] = await db.insert(events).values({ groupId, name: 'Audit shift', slug: 'audit', startTime: occurrence, rrule: 'FREQ=DAILY' }).returning()
    const [sheet] = await db.insert(signupSheets).values({ groupId, enabled: true }).returning()
    const slots = await db.insert(signupSlots).values(Array.from({ length: 4 }, (_, index) => ({ sheetId: sheet!.id, name: 'Slot ' + index, capacity: index === 0 ? 1 : 12 }))).returning()
    const insert = (slot: number, actor: number, discord = false) => db.insert(shiftSignups).values({ eventId: event!.eventId, slotId: slots[slot]!.id, occurrence,
        ...(discord ? { discordUserId: 'audit-discord-' + actor } : { userId: actors[actor] }) }).returning()
    const race = await Promise.allSettled(actors.map((_, index) => insert(0, index)))
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    await db.delete(shiftSignups).where(eq(shiftSignups.eventId, event!.eventId))
    const duplicate = await Promise.allSettled([insert(1, 0), insert(2, 0, true)])
    assert.equal(duplicate.filter(result => result.status === 'fulfilled').length, 1)
    await db.delete(shiftSignups).where(eq(shiftSignups.eventId, event!.eventId))
    const [held] = await insert(1, 0)
    await insert(0, 1)
    await assert.rejects(db.update(shiftSignups).set({ slotId: slots[0]!.id }).where(eq(shiftSignups.id, held!.id)))
    const [preserved] = await db.select().from(shiftSignups).where(eq(shiftSignups.id, held!.id))
    assert.equal(preserved!.slotId, slots[1]!.id)
    console.log('PASS: 12 concurrent reservations, cross-identity duplicates and failed move preservation')
    await db.delete(shiftSignups).where(eq(shiftSignups.eventId, event!.eventId))
    const httpRace = await Promise.all(actorTokens.map(caller => request('/schedule/signup', 'POST', { eventId: event!.eventId, slotId: slots[0]!.id, occurrence }, 'cookie', caller)))
    assert.equal(httpRace.filter(response => response.status === 200).length, 1)
    assert.equal(httpRace.filter(response => response.status === 409).length, 11)
    await db.delete(shiftSignups).where(eq(shiftSignups.eventId, event!.eventId))
    const httpDuplicate = await Promise.all([1, 2].map(slot => request('/schedule/signup', 'POST', { eventId: event!.eventId, slotId: slots[slot]!.id, occurrence }, 'cookie', actorTokens[0]!)))
    assert.deepEqual(httpDuplicate.map(response => response.status).sort(), [200, 409])
    console.log('PASS: concurrent website reservations return one success and HTTP 409 conflicts')

    const { MediaService } = await import('../src/media/service')
    const ownerSession = await ResolveSession(token, undefined)
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], 'audit.png', { type: 'image/png' })
    try {
        await db.execute(sql.raw("CREATE FUNCTION audit_fail_media() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit insert failure'; END $$"))
        await db.execute(sql.raw('CREATE TRIGGER audit_fail_media BEFORE INSERT ON media FOR EACH ROW EXECUTE FUNCTION audit_fail_media()'))
        await assert.rejects(MediaService.upload({ groupId, ownerType: 'GROUP', file }, ownerSession))
        assert.deepEqual(objectRequests, ['PUT', 'DELETE'])
    } finally {
        await db.execute(sql.raw('DROP TRIGGER IF EXISTS audit_fail_media ON media'))
        await db.execute(sql.raw('DROP FUNCTION IF EXISTS audit_fail_media()'))
    }
    try {
        await db.execute(sql.raw("CREATE FUNCTION audit_fail_icon() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit link failure'; END $$"))
        await db.execute(sql.raw('CREATE TRIGGER audit_fail_icon BEFORE UPDATE OF icon_media_id ON routes FOR EACH ROW EXECUTE FUNCTION audit_fail_icon()'))
        await assert.rejects(MediaService.setIcon({ groupId, ownerType: 'ROUTE', ownerId: route!.id, file }, ownerSession))
        assert.deepEqual(objectRequests, ['PUT', 'DELETE', 'PUT', 'DELETE'])
        assert.equal((await db.select().from(media).where(eq(media.groupId, groupId))).length, 0)
    } finally {
        await db.execute(sql.raw('DROP TRIGGER IF EXISTS audit_fail_icon ON routes'))
        await db.execute(sql.raw('DROP FUNCTION IF EXISTS audit_fail_icon()'))
    }
    console.log('PASS: uploaded objects and icon rows are cleaned up after insert/link failures')

    const [image] = await db.insert(media).values({ groupId, ownerType: 'ROUTE', ownerId: route!.id, key: 'audit.png', contentType: 'image/png', size: 8 }).returning()
    await db.insert(reports).values([{ targetType: 'GROUP' as const, targetId: groupId, reporterId: ownerId, reason: 'test' },
        { targetType: 'ROUTE' as const, targetId: route!.id, reporterId: ownerId, reason: 'test' },
        { targetType: 'DEPOT' as const, targetId: depot!.id, reporterId: ownerId, reason: 'test' },
        { targetType: 'MEDIA' as const, targetId: image!.id, reporterId: ownerId, reason: 'test' }])
    const { Reports } = await import('../src/reports/service')
    const originalSelect = db.select.bind(db)
    let reads = 0
    db.select = ((...args: unknown[]) => { reads++; return (originalSelect as Function)(...args) }) as typeof db.select
    let listed: Awaited<ReturnType<typeof Reports.list>>
    try { listed = await Reports.list({}, ownerSession) } finally { db.select = originalSelect }
    assert.ok(reads <= 7, `Report list used ${reads} select calls`)
    assert.equal(listed.length, 4)
    assert.equal(listed.find(item => item.targetType === 'ROUTE')!.target!.images.length, 1)
    assert.equal(listed.find(item => item.targetType === 'MEDIA')!.target!.images.length, 1)
    await db.update(groups).set({ moderation: 'APPROVED' }).where(eq(groups.id, groupId))
    const moderatorSession = { ...ownerSession, user: { ...ownerSession.user!, userId: actors[0]! } }
    assert.equal((await Reports.create({ targetType: 'GROUP', targetId: groupId, reason: 'test' }, moderatorSession)).hidden, false)
    assert.equal((await db.select().from(groups).where(eq(groups.id, groupId)))[0]!.moderation, 'APPROVED')
    console.log('PASS: batched report snapshots preserve images and approved content')

    if (process.env.AUDIT_UI === 'true') {
        await Bun.write('/tmp/trptools-audit-ui.json', JSON.stringify({ token, groupId, routeId: route!.id }))
        app.listen({ port: 54381, hostname: '127.0.0.1' })
        console.log('Audit UI fixture ready at http://localhost:54381')
        await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
        await app.stop()
    }
} finally {
    await db.delete(reports).where(inArray(reports.reporterId, [ownerId, ...actors]))
    await db.delete(groups).where(eq(groups.id, groupId))
    await db.delete(users).where(inArray(users.id, [ownerId, ...actors]))
    await dataRedis.del(`perm:${groupId}:${ownerId}`)
    await dataRedis.del(...actors.map(userId => `perm:${groupId}:${userId}`))
    await client?.end()
    storage.stop(true)
}
process.exit(0)
