import assert from 'node:assert/strict'
import { and, eq, inArray, sql } from 'drizzle-orm'
if (!process.env.DATABASE_URL?.endsWith('/trptools_shifts_test') || !process.env.REDIS_URL?.endsWith(':54233')) throw new Error('Use the isolated trptools_shifts_test database and Redis port 54233')
Object.assign(process.env, { ROBLOX_CLIENT_ID: 'test', ROBLOX_CLIENT_SECRET: 'test', ROBLOX_API_KEY: '', ENCRYPTION_KEY: 'isolated-test',
    FRONTEND_URL: 'http://localhost:54200', BASE_URL: 'http://localhost:54201', SITE_ADMINS: '', BOT_SERVICE_TOKEN: 'shift-test-service',
    BOT_WORKER_URL: '', BOT_WORKER_SYNC_TOKEN: '', DISCORD_APP_ID: '', DISCORD_BOT_TOKEN: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })
const realFetch = fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return realFetch(input, init)
    throw new Error('External providers are disabled in the shift fixture')
}) as typeof fetch
const { app } = await import('../src/index')
const { default: db, client } = await import('../src/db')
const { groups, users, sessions, events, botConfigs, shiftOccurrences, shiftVotes, shiftDrivers, signupSheets, signupSlots, shiftSignups } = await import('../src/db/schema')
const { dataRedis } = await import('../src/utils/redis')
const { adoptDiscordVotes } = await import('../src/schedule/identity')
const { hashToken } = await import('../src/utils/sessionVerifier')
const { PERM } = await import('../src/utils/permissions')
const { ensureInstance, decideInstance, preparationAllowed, recordDrivers } = await import('../src/schedule/instances')
const { dueActions } = await import('../src/bot/scheduler')
const groupId = crypto.randomUUID(), ownerId = crypto.randomUUID(), memberId = crypto.randomUUID(), guestId = crypto.randomUUID()
const ownerToken = crypto.randomUUID(), memberToken = crypto.randomUUID(), guestToken = crypto.randomUUID()
let keep = false
async function prime() {
    await dataRedis.set(`perm:${groupId}:${ownerId}`, `3:255:${PERM.ADMINISTRATOR}:`, 'EX', 3600)
    await dataRedis.set(`perm:${groupId}:${memberId}`, '0:50:0:', 'EX', 3600)
    await dataRedis.set(`perm:${groupId}:${guestId}`, '0:-1:0:', 'EX', 3600)
}
async function call(path: string, expected = 200, method = 'GET', body?: unknown, token: string | null = ownerToken, internal = false) {
    const response = await app.handle(new Request('http://localhost:54201' + path, { method, headers: {
        origin: 'http://localhost:54200', ...(token ? { cookie: `access_token=${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(internal ? { authorization: 'Bearer shift-test-service' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    const text = await response.text(); const result = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`)
    return result
}
try {
    await db.delete(users).where(inArray(users.robloxId, [9901, 9902, 9903]))
    await db.insert(groups).values({ id: groupId, robloxId: '99980001', slug: 'shift-test', cachedName: 'Shift Test', cachedAt: new Date(), visibility: 'PUBLIC', signupLeadMinutes: 1440 })
    await db.insert(users).values([{ id: ownerId, robloxId: 9901, cachedUsername: 'TestOwner', cachedAt: new Date() }, { id: memberId, robloxId: 9902, cachedUsername: 'TestMember', cachedAt: new Date(), discordId: 'discord-member' }, { id: guestId, robloxId: 9903, cachedUsername: 'Guest', cachedAt: new Date() }])
    await db.insert(sessions).values([ownerId, memberId, guestId].map((userId, i) => ({ userId, sessionId: hashToken([ownerToken, memberToken, guestToken][i]!), expiresAt: new Date(Date.now() + 86400000) })))
    await prime()
    await db.insert(botConfigs).values({ groupId, guildId: 'shift-test-guild', announcementChannel: 'public-channel', announcementsEnabled: true, autoAnnounce: true, signupsEnabled: true, autoSignups: true, autoSignupsLead: 60, remindersEnabled: true, autoHostReminder: true, autoHostReminderLead: 60 })
    const start = new Date(Math.ceil((Date.now() + 120 * 60000) / 1000) * 1000)
    const created = await call('/schedule', 200, 'POST', { groupId, name: 'On-demand evening', startTime: start.toISOString(), rrule: 'FREQ=DAILY;COUNT=5', duration: 60,
        onDemand: true, minimumVotes: 2, minimumRank: 50, voteLeadMinutes: 240, decisionLeadMinutes: 60, postDescription: 'AFTER ONLY' })
    const eventId = created.eventId
    const [event] = await db.select().from(events).where(eq(events.eventId, eventId))
    const row = await ensureInstance(event!, start)
    const path = `/schedule/instances/${row.id}`
    await call('/schedule/instances?groupId=' + groupId, 403, 'GET', undefined, memberToken)
    const anonymous = await call(path, 200, 'GET', undefined, null)
    assert.equal(anonymous.postDescription, ''); assert.deepEqual(anonymous.staff, []); assert.deepEqual(anonymous.voters, []); assert.equal(anonymous.canVote, false)
    await call(path, 403, 'PATCH', { description: 'Unauthorized' }, memberToken)
    await dataRedis.set(`perm:${groupId}:${memberId}`, `2:50:${PERM.MANAGE_SHIFTS}:`, 'EX', 3600)
    await call('/media?groupId=' + groupId + '&ownerType=SHIFT&ownerId=' + row.id, 200, 'GET', undefined, memberToken)
    await dataRedis.set(`perm:${groupId}:${memberId}`, '0:50:0:', 'EX', 3600)
    await call('/media?groupId=' + groupId + '&ownerType=SHIFT&ownerId=' + row.id, 403, 'GET', undefined, memberToken)
    await call(path, 200, 'PATCH', { description: 'BEFORE', translations: { postDescription: { de: 'SECRET AFTER' } } })
    assert.deepEqual((await call(path, 200, 'GET', undefined, null)).translations.postDescription, {})
    await call(path + '/vote', 401, 'POST', { attending: true }, null)
    await call(path + '/vote', 403, 'POST', { attending: true }, guestToken)
    await call(path + '/vote', 200, 'POST', { attending: true }, memberToken)
    await Promise.all(Array.from({ length: 6 }, () => call(path + '/vote', 200, 'POST', { attending: true }, memberToken)))
    assert.equal((await call(path)).voteCount, 1)
    await call('/bot/internal/guilds/shift-test-guild/vote', 200, 'POST', { eventId, occurrence: start.toISOString(), discordUserId: 'discord-member', name: 'DiscordMember', attending: true }, null, true)
    assert.equal((await call(path)).voteCount, 1)
    await db.update(shiftOccurrences).set({ minimumRank: 0 }).where(eq(shiftOccurrences.id, row.id))
    // Linking two identities merges their existing votes while voting is pending.
    await db.update(users).set({ discordId: null }).where(eq(users.id, memberId))
    await call(path + '/vote', 200, 'POST', { attending: true }, memberToken)
    await call('/bot/internal/guilds/shift-test-guild/vote', 200, 'POST', { eventId, occurrence: start.toISOString(), discordUserId: 'discord-member', name: 'DiscordMember', attending: true }, null, true)
    assert.equal((await call(path)).voteCount, 2)
    await db.update(users).set({ discordId: 'discord-member' }).where(eq(users.id, memberId))
    await adoptDiscordVotes(memberId, 'discord-member')
    assert.equal((await call(path)).voteCount, 1)
    await call(path + '/vote', 200, 'POST', { attending: false }, memberToken)
    assert.equal((await call(path)).voteCount, 0)
    assert.equal((await call(path)).withdrawnVoters.length, 1)
    assert.equal((await call(path, 200, 'GET', undefined, null)).withdrawnVoters.length, 0)
    await call('/schedule/' + eventId, 200, 'PATCH', { postDescription: 'RULE SECRET', translations: { postDescription: { fr: 'RULE SECRET FR' } } })
    const publicRule = await call('/schedule/' + eventId, 200, 'GET', undefined, null)
    assert.equal(publicRule.postDescription, '')
    assert.equal(JSON.stringify(publicRule.translations).includes('RULE SECRET'), false)
    await call(path, 200, 'PATCH', { postDescription: 'AFTER ONLY' })
    await call('/schedule/' + eventId, 200, 'PATCH', { postDescription: 'CHANGED DEFAULT' })
    assert.equal((await call(path)).postDescription, 'AFTER ONLY')
    await call(path + '/vote', 200, 'POST', { attending: true }, memberToken)
    await db.update(shiftOccurrences).set({ minimumRank: 0, voteRequireDiscord: true, websiteVoting: false }).where(eq(shiftOccurrences.id, row.id))
    await call(path + '/vote', 403, 'POST', { attending: true }, memberToken)
    await call(path + '/vote', 200, 'POST', { attending: false }, memberToken)
    await call('/bot/internal/guilds/shift-test-guild/vote', 200, 'POST', { eventId, occurrence: start.toISOString(), discordUserId: 'unlinked-discord', name: 'DiscordGuest', attending: true }, null, true)
    await db.update(shiftOccurrences).set({ websiteVoting: true, minimumRank: 50 }).where(eq(shiftOccurrences.id, row.id))
    await call('/bot/internal/guilds/shift-test-guild/vote', 403, 'POST', { eventId, occurrence: start.toISOString(), discordUserId: 'another-unlinked', name: 'Unlinked', attending: true }, null, true)
    await call(path + '/vote', 200, 'POST', { attending: true }, memberToken)
    const [sheet] = await db.insert(signupSheets).values({ groupId, name: 'Staff', enabled: true }).returning()
    const [slot] = await db.insert(signupSlots).values({ sheetId: sheet!.id, name: 'Dispatcher', capacity: 2 }).returning()
    await call('/schedule/signup', 409, 'POST', { slotId: slot!.id, eventId, occurrence: start.toISOString() }, memberToken)
    assert.equal(await preparationAllowed(event!, start), false)
    await db.update(shiftOccurrences).set({ decisionAt: new Date(Date.now() - 1000) }).where(eq(shiftOccurrences.id, row.id))
    assert.equal((await decideInstance((await db.select().from(shiftOccurrences).where(eq(shiftOccurrences.id, row.id)))[0]!)).decision, 'CONFIRMED')
    await call(path + '/vote', 409, 'POST', { attending: false }, memberToken)
    await call('/schedule/signup', 200, 'POST', { slotId: slot!.id, eventId, occurrence: start.toISOString() }, memberToken)
    assert.equal((await call(path, 200, 'GET', undefined, memberToken)).sheets[0].slots[0].signups.length, 1)
    await recordDrivers(eventId, start, [{ robloxId: '9902', name: '9902' }, { robloxId: '9902', name: '9902' }, { robloxId: '0', name: 'Scenery' }])
    assert.equal((await call(path)).drivers.length, 1)
    // The final outcome and historical records survive rule changes and sheet deletion.
    await db.update(shiftOccurrences).set({ end: new Date(Date.now() - 1000) }).where(eq(shiftOccurrences.id, row.id))
    assert.equal((await call(path, 200, 'GET', undefined, null)).postDescription, 'AFTER ONLY')
    assert.equal((await call(path, 200, 'GET', undefined, null)).staff.length, 0)
    assert.equal((await call(path, 200, 'GET', undefined, null)).drivers.length, 0)
    await call(path, 200, 'PATCH', { publicStaff: true, publicDrivers: true, showVoters: true })
    const published = await call(path, 200, 'GET', undefined, null)
    assert.equal(published.staff.length, 1); assert.equal(published.drivers.length, 1); assert.equal(published.voters.length, 2)
    await db.delete(signupSheets).where(eq(signupSheets.id, sheet!.id))
    assert.equal((await call(path)).staff.length, 1)
    const past = new Date(Math.floor((Date.now() - 2 * 3600000) / 1000) * 1000)
    const failedEvent = await call('/schedule', 200, 'POST', { groupId, name: 'Failed demand', startTime: past.toISOString(), rrule: 'FREQ=DAILY;COUNT=3', duration: 30, onDemand: true, minimumVotes: 10 })
    const [failure] = await db.select().from(events).where(eq(events.eventId, failedEvent.eventId))
    const failedRow = await ensureInstance(failure!, past)
    const failed = await call(`/schedule/instances/${failedRow.id}`, 200, 'GET', undefined, null)
    assert.equal(failed.decision, 'FAILED'); assert.equal(failed.signupsOpen, false)
    assert.equal(await preparationAllowed(failure!, past), false)
    const pastList = await call('/schedule/instances?groupId=' + groupId + '&past=true')
    assert.ok(pastList.some((item: any) => item.id === failedRow.id))
    await call(path, 200, 'PATCH', { visibility: 'PRIVATE' })
    await call(path, 404, 'GET', undefined, null)
    await call(path, 200, 'PATCH', { visibility: 'PUBLIC' })
    await call('/schedule/' + eventId, 200, 'DELETE')
    assert.ok(!(await call('/schedule?groupId=' + groupId)).some((event: any) => event.eventId === eventId))
    await call(`/schedule/instance?groupId=shift-test&slug=${row.slug}&occurrence=${encodeURIComponent(start.toISOString())}`, 200, 'GET', undefined, null)
    assert.equal((await call(path)).staff.length, 1)
    const invalid = new Date(start.getTime() + 123)
    await call(`/schedule/instance?groupId=shift-test&slug=${failure!.slug}&occurrence=${encodeURIComponent(invalid.toISOString())}`, 400, 'GET', undefined, null)
    await call('/schedule/' + failure!.eventId, 400, 'PATCH', { onDemand: true, voteLeadMinutes: 60, decisionLeadMinutes: 60 })
    // Automation confirms at the cutoff, redraws both outcomes, and prepares only confirmed shifts.
    const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000 + 5000)
    const automationStart = new Date(cutoff.getTime() + 60 * 60000)
    const automated: Array<{ eventId: string; id: string; confirmed: boolean }> = []
    for (const confirmed of [true, false]) {
        const created = await call('/schedule', 200, 'POST', { groupId, name: confirmed ? 'Confirmed automation' : 'Failed automation', startTime: automationStart.toISOString(), rrule: 'FREQ=DAILY;COUNT=1', duration: 30, onDemand: true, minimumVotes: 1, voteLeadMinutes: 120, decisionLeadMinutes: 60 })
        const [event] = await db.select().from(events).where(eq(events.eventId, created.eventId))
        const instance = await ensureInstance(event!, automationStart)
        if (confirmed) await call(`/schedule/instances/${instance.id}/vote`, 200, 'POST', { attending: true }, memberToken)
        automated.push({ eventId: created.eventId, id: instance.id, confirmed })
    }
    const due = await dueActions(cutoff)
    for (const shift of automated) {
        assert.ok(due.some(action => action.eventId === shift.eventId && action.action === 'REFRESH'))
        assert.equal(due.some(action => action.eventId === shift.eventId && action.action === 'SIGNUPS'), shift.confirmed)
        assert.equal(due.some(action => action.eventId === shift.eventId && action.action === 'HOST_REMINDER'), shift.confirmed)
    }
    assert.equal((await call(`/schedule/instances/${automated[1]!.id}`)).decision, 'FAILED')
    await call('/schedule/' + automated[1]!.eventId, 200, 'DELETE')
    assert.equal((await call(`/schedule/instances/${automated[1]!.id}`)).decision, 'FAILED')
    // Editing a rule updates untouched future pages and cancels dates it no longer produces.
    const normal = await call('/schedule', 200, 'POST', { groupId, name: 'Rule edit', startTime: start.toISOString(), rrule: 'FREQ=DAILY;COUNT=1', duration: 30 })
    const [normalEvent] = await db.select().from(events).where(eq(events.eventId, normal.eventId))
    const normalRow = await ensureInstance(normalEvent!, start)
    await call('/schedule/' + normal.eventId, 200, 'PATCH', { onDemand: true, minimumVotes: 7, voteLeadMinutes: 240, decisionLeadMinutes: 60 })
    assert.equal((await call(`/schedule/instances/${normalRow.id}`)).onDemand, true)
    assert.equal((await call(`/schedule/instances/${normalRow.id}`)).minimumVotes, 7)
    await call('/schedule/' + normal.eventId, 200, 'PATCH', { startTime: new Date(start.getTime() + 3600000).toISOString() })
    assert.equal((await call(`/schedule/instances/${normalRow.id}`)).decision, 'CANCELED')
    console.log('Shift API integration passed: permissions, privacy, identity, concurrent votes, cutoffs, staffing ledger, driver history, failed demand, and archive links.')
    if (process.argv.includes('--serve')) {
        keep = true
        // A future ordinary shift makes the UI fixture useful after voting tests finish.
        const demo = await call('/schedule', 200, 'POST', { groupId, name: 'Evening service', startTime: start.toISOString(), rrule: 'FREQ=WEEKLY;COUNT=4', duration: 60 })
        const future = await call('/schedule/instances?groupId=' + groupId)
        await Bun.write('/tmp/trptools-shifts-fixture.json', JSON.stringify({ groupId, ownerToken, memberToken, guestToken, eventId: demo.eventId, instanceId: future.find((s: any) => s.eventId === demo.eventId).id, failedId: failedRow.id, failedSlug: failed.slug, failedStart: past.getTime() }))
        app.listen({ port: 54201, hostname: '127.0.0.1' })
        console.log('Shift UI fixture ready on :54201')
        setInterval(() => void prime(), 30000)
        await new Promise(() => {})
    }
} finally {
    if (!keep) {
        await db.delete(groups).where(eq(groups.id, groupId))
        await db.delete(users).where(inArray(users.id, [ownerId, memberId, guestId]))
        await client?.end()
    }
}

process.exit(0)
