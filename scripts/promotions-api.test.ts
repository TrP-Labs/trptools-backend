import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { OAuth2Tokens } from 'arctic'

// The same isolation as the claimables fixture: a database and a Redis of its
// own, and every Roblox request answered from memory.
if (!process.env.DATABASE_URL?.endsWith('/trptools_promotion_test') || !process.env.REDIS_URL?.endsWith(':54133')) {
    throw new Error('Use the isolated trptools_promotion_test database and Redis port 54133')
}
Object.assign(process.env, { ROBLOX_CLIENT_ID: 'promotion-test', ROBLOX_CLIENT_SECRET: 'promotion-test', ROBLOX_API_KEY: 'promotion-test-key',
    BASE_URL: 'http://localhost:54201', FRONTEND_URL: 'http://localhost:54200', ENCRYPTION_KEY: 'promotion-test-key', SITE_ADMINS: '',
    DISCORD_APP_ID: '', DISCORD_BOT_TOKEN: '', DISCORD_CLIENT_SECRET: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })

const GROUP = '99900002'
const realFetch = globalThis.fetch
const roles = [
    { id: '1', displayName: 'Member', rank: 1 }, { id: '5', displayName: 'Trainee', rank: 5 },
    { id: '10', displayName: 'Driver', rank: 10 }, { id: '20', displayName: 'Senior', rank: 20 },
    { id: '100', displayName: 'Host', rank: 100 }, { id: '150', displayName: 'Manager', rank: 150 },
    { id: '200', displayName: 'Director', rank: 200 }, { id: '255', displayName: 'Owner', rank: 255 }
]
// Roblox id → role ids held. 1 owner (holds the write consent), 2 and 3
// drivers, 4 a host who reads the page, 5 a manager who presses its buttons.
const memberships = new Map<number, string[]>([[1, ['255']], [2, ['1', '10']], [3, ['10']], [4, ['100']], [5, ['150']], [6, ['1']]])
const writes: string[] = []
const rolePath = (id: string) => `groups/${GROUP}/roles/${id}`
const top = (ids: string[]) => ids.reduce((a, b) => Number(a) > Number(b) ? a : b)
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return realFetch(input, init)
    if (input instanceof Request) init = { method: input.method, headers: input.headers,
        ...(!['GET', 'HEAD'].includes(input.method) ? { body: await input.clone().text() } : {}), ...init }
    if (url.hostname === 'apis.roblox.com' && url.pathname === '/oauth/v1/token') {
        return Response.json({ access_token: 'mock-write', refresh_token: 'mock-refresh', expires_in: 900, token_type: 'Bearer', scope: 'openid profile group:read group:write' })
    }
    if (url.hostname === 'apis.roblox.com' && url.pathname === '/oauth/v1/token/introspect') {
        return Response.json({ active: true, sub: '1', client_id: 'promotion-test', scope: 'openid profile group:read group:write' })
    }
    if (url.hostname === 'groups.roblox.com' && /\/v1\/groups\/\d+\/roles\/\d+\/users/.test(url.pathname)) {
        const role = url.pathname.split('/')[5]
        return Response.json({ data: [...memberships].filter(([, ids]) => top(ids) === role).map(([userId]) => ({ userId, username: `User${userId}`, displayName: `User${userId}` })) })
    }
    if (url.hostname === 'users.roblox.com') return Response.json({ data: [] })
    if (url.hostname === 'thumbnails.roblox.com') return Response.json({ data: [] })
    if (url.hostname !== 'apis.roblox.com') throw new Error(`External provider disabled in the promotion fixture: ${url.hostname}`)
    if (url.pathname.endsWith('/roles')) return Response.json({ groupRoles: roles })
    const single = url.pathname.match(/\/roles\/(\d+)$/)
    if (single) return Response.json(roles.find((role) => role.id === single[1]) ?? {})
    if (url.pathname.endsWith('/memberships')) {
        const uid = Number(url.searchParams.get('filter')?.match(/users\/(\d+)/)?.[1])
        const ids = memberships.get(uid)
        return Response.json({ groupMemberships: ids ? [{ path: `groups/${GROUP}/memberships/${uid}`, user: `users/${uid}`, role: rolePath(top(ids)), roles: ids.map(rolePath) }] : [] })
    }
    if (url.pathname.includes(':assignRole') || url.pathname.includes(':unassignRole')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-write')
        const uid = Number(url.pathname.match(/memberships\/(\d+)/)?.[1]), role = JSON.parse(String(init?.body)).role.split('/').at(-1)
        writes.push(`${url.pathname.includes(':assignRole') ? '+' : '-'}${uid}:${role}`)
        const current = memberships.get(uid)!
        memberships.set(uid, url.pathname.includes(':unassignRole') ? current.filter((id) => id !== role) : [...new Set([...current, role])])
        return Response.json({})
    }
    if (url.pathname.endsWith(`/groups/${GROUP}`)) return Response.json({ id: GROUP, displayName: 'Promotion Test', owner: 'users/1', memberCount: 6 })
    throw new Error(`Unexpected mock provider request ${url.pathname}`)
}) as typeof fetch

const { app } = await import('../src/index')
const { default: db, client } = await import('../src/db')
const schema = await import('../src/db/schema')
const { users, groups, rankRelations, sessions, auditMessages, claimableConnections, events, shiftOccurrences, shiftAttendance,
    signupSheets, signupSlots, shiftSignups, rankSlotPoints } = schema
const { hashToken } = await import('../src/utils/sessionVerifier')
const { deleteByPattern } = await import('../src/utils/redis')
const { storeUserTokens } = await import('../src/utils/robloxCredentials')
const { PERM } = await import('../src/utils/permissions')

const ids = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, crypto.randomUUID()])) as Record<number, string>
const tokens = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, crypto.randomUUID()])) as Record<number, string>
const groupId = crypto.randomUUID()

async function call(path: string, method = 'GET', body?: unknown, who = 5) {
    const response = await app.handle(new Request('http://localhost:54201' + path, { method, headers: {
        cookie: `access_token=${tokens[who]}`, origin: 'http://localhost:54200', ...(body ? { 'content-type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    const text = await response.text()
    return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text }
}
async function expectStatus(path: string, status: number, method = 'GET', body?: unknown, who = 5) {
    const result = await call(path, method, body, who)
    assert.equal(result.status, status, `${method} ${path} as ${who}: ${JSON.stringify(result.data)}`)
    return result.data
}

try {
    await db.insert(users).values([1, 2, 3, 4, 5, 6].map((n) => ({ id: ids[n]!, robloxId: n, cachedUsername: `User${n}`, cachedAt: new Date() })))
    for (const n of [1, 2, 3, 4, 5, 6]) {
        await db.insert(sessions).values({ sessionId: hashToken(tokens[n]!), userId: ids[n]!, expiresAt: new Date(Date.now() + 86400_000) })
        await storeUserTokens(ids[n]!, new OAuth2Tokens({ access_token: 'mock-read', expires_in: 900, scope: 'openid profile group:read' }))
    }
    await storeUserTokens(ids[1]!, new OAuth2Tokens({ access_token: 'mock-write', refresh_token: 'mock-refresh', expires_in: 900, scope: 'openid profile group:read group:write' }), [], true)
    await db.insert(groups).values({ id: groupId, robloxId: GROUP, slug: 'promotion-test', visibility: 'PUBLIC', cachedName: 'Promotion Test', cachedAt: new Date(), cachedMembers: 6 })
    const grants: Record<string, number> = {
        '255': PERM.ADMINISTRATOR,
        '100': PERM.VIEW_DASHBOARD | PERM.MANAGE_ATTENDANCE,
        '150': PERM.VIEW_DASHBOARD | PERM.MANAGE_ATTENDANCE | PERM.MANAGE_PROMOTIONS
    }
    const ranks = await db.insert(rankRelations).values(roles.map((role) => ({ groupId, robloxId: role.id, cachedName: role.displayName,
        cachedRank: role.rank, permissions: grants[role.id] ?? 0, permissionLevel: role.rank === 255 ? 3 : grants[role.id] ? 2 : 0 }))).returning()
    const rank = (id: string) => ranks.find((row) => row.robloxId === id)!
    await db.insert(claimableConnections).values({ groupId, authorizedBy: ids[1]! })

    // Two shifts this month, both over.
    const now = Date.now()
    const [event] = await db.insert(events).values({ groupId, name: 'Service', slug: 'service', rrule: 'FREQ=DAILY', startTime: new Date(now - 3 * 3600_000), duration: 60 } as never).returning()
    const startA = new Date(Math.max(now - 3 * 3600_000, Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)))
    const startB = new Date(startA.getTime() + 61 * 60_000)
    const occurrences = await db.insert(shiftOccurrences).values([startA, startB].map((start, index) => ({
        eventId: event!.eventId, groupId, start, end: new Date(start.getTime() + 3600_000), name: 'Service', slug: 'service', color: '#4287f5',
        voteOpensAt: start, decisionAt: start, decision: 'SCHEDULED', description: String(index)
    }))).returning()
    const [sheet] = await db.insert(signupSheets).values({ groupId, name: 'Staff', enabled: true }).returning()
    const [slot] = await db.insert(signupSlots).values({ sheetId: sheet!.id, name: 'Dispatcher', capacity: 2 }).returning()
    // User 2: on the server for all of shift A (unsigned), and signed up as a
    // dispatcher for shift B and there for it. User 3: never turned up.
    await db.insert(shiftAttendance).values([
        { occurrenceId: occurrences[0]!.id, robloxId: '2', name: 'User2', seconds: 3600 },
        { occurrenceId: occurrences[1]!.id, robloxId: '2', name: 'User2', seconds: 3000 },
        { occurrenceId: occurrences[1]!.id, robloxId: '6', name: 'User6', seconds: 3600 }
    ])
    await db.insert(shiftSignups).values({ slotId: slot!.id, eventId: event!.eventId, userId: ids[2]!, occurrence: startB })

    // --- rank settings ---------------------------------------------------------
    const driver = rank('10')
    await expectStatus(`/attendance/ranks/${driver.id}`, 403, 'GET', undefined, 2)
    const settings = await expectStatus(`/attendance/ranks/${driver.id}`, 200, 'GET', undefined, 4)
    assert.deepEqual(settings.slots.map((s: { name: string }) => s.name), ['Dispatcher'])
    await expectStatus(`/attendance/ranks/${driver.id}`, 200, 'PUT', {
        minPoints: 1, maxPoints: 2, requiredPercent: 50, unsignedPoints: 0.5,
        promotionRankId: rank('20').id, demotionRankId: rank('5').id, slots: [{ slotId: slot!.id, points: 2 }]
    }, 4)
    const saved = await expectStatus(`/attendance/ranks/${driver.id}`, 200, 'GET', undefined, 4)
    assert.equal(saved.slots[0].points, 2); assert.equal(saved.maxPoints, 2)

    // --- standings ---------------------------------------------------------------
    await expectStatus(`/attendance/groups/${groupId}/standings`, 403, 'GET', undefined, 2)
    const read = await expectStatus(`/attendance/groups/${groupId}/standings`, 200, 'GET', undefined, 4)
    assert.equal(read.canApply, false)
    const standings = await expectStatus(`/attendance/groups/${groupId}/standings`, 200)
    assert.equal(standings.canApply, true); assert.equal(standings.connection.connected, true)
    const byId = new Map(standings.people.map((p: { robloxId: string }) => [p.robloxId, p]))
    // Shift A unsigned (0.5) plus shift B signed up (2, not 2.5): mutually exclusive.
    assert.deepEqual(byId.get('2'), { ...(byId.get('2') as object), points: 2.5, shifts: 2, verdict: 'PROMOTE', targetRankName: 'Senior' })
    assert.equal((byId.get('3') as { verdict: string }).verdict, 'DEMOTE')
    assert.equal((byId.get('3') as { points: number }).points, 0)
    // A member whose rank has no rules is listed with points and no verdict.
    assert.equal((byId.get('6') as { verdict: null }).verdict, null)
    assert.equal(byId.has('1'), false)

    // --- applying ----------------------------------------------------------------
    const month = standings.month
    await expectStatus(`/attendance/groups/${groupId}/apply`, 403, 'POST', { robloxId: '2', verdict: 'PROMOTE', month }, 4)
    await expectStatus(`/attendance/groups/${groupId}/apply`, 409, 'POST', { robloxId: '2', verdict: 'DEMOTE', month })
    assert.deepEqual((await expectStatus(`/attendance/groups/${groupId}/apply`, 200, 'POST', { robloxId: '2', verdict: 'PROMOTE', month })), { state: 'CONFIRMED' })
    // Assigned before anything is removed, and the base Member role is kept.
    assert.deepEqual(writes, ['+2:20', '-2:10'])
    assert.deepEqual(memberships.get(2), ['1', '20'])
    await expectStatus(`/attendance/groups/${groupId}/apply`, 409, 'POST', { robloxId: '2', verdict: 'PROMOTE', month })
    assert.deepEqual(await expectStatus(`/attendance/groups/${groupId}/apply`, 200, 'POST', { robloxId: '3', verdict: 'DEMOTE', month }), { state: 'CONFIRMED' })
    assert.deepEqual(memberships.get(3), ['5'])

    // Nobody may move somebody to a rank at or above their own.
    memberships.set(3, ['10'])
    await deleteByPattern('roblox:*')
    await db.update(rankRelations).set({ promotionRankId: rank('200').id, attendanceMaxPoints: -1 }).where(eq(rankRelations.id, driver.id))
    await expectStatus(`/attendance/groups/${groupId}/apply`, 403, 'POST', { robloxId: '3', verdict: 'PROMOTE', month })
    assert.deepEqual(memberships.get(3), ['10'])

    const audit = await db.select().from(auditMessages).where(eq(auditMessages.groupId, groupId))
    assert.equal(audit.filter((row) => row.action === 'rank.promote').length, 1)
    assert.equal(audit.filter((row) => row.action === 'rank.demote').length, 1)
    // The ceiling refused it before Roblox was asked to change anything.
    assert.equal(writes.length, 4)
    void rankSlotPoints
    console.log('Promotions API: settings, grants, points arithmetic, standings, stale verdicts, role replacement, rank ceilings and audit passed.')
} finally {
    globalThis.fetch = realFetch
    await db.delete(groups).where(eq(groups.id, groupId))
    for (const n of [1, 2, 3, 4, 5, 6]) await db.delete(users).where(eq(users.id, ids[n]!))
    await client?.end()
}
process.exit(0)
