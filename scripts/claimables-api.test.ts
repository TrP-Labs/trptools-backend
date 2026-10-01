import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { OAuth2Tokens } from 'arctic'

if (!process.env.DATABASE_URL?.endsWith('/trptools_claimable_test') || !process.env.REDIS_URL?.endsWith(':54132')) {
    throw new Error('Use the isolated trptools_claimable_test database and Redis port 54132')
}
Object.assign(process.env, { ROBLOX_CLIENT_ID: 'claimable-test', ROBLOX_CLIENT_SECRET: 'claimable-test', ROBLOX_API_KEY: '',
    BASE_URL: 'http://localhost:54101', FRONTEND_URL: 'http://localhost:54100', ENCRYPTION_KEY: 'claimable-test-key', SITE_ADMINS: '',
    DISCORD_APP_ID: '', DISCORD_BOT_TOKEN: '', DISCORD_CLIENT_SECRET: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })
const realFetch = globalThis.fetch
const roles = [{ id: '1', displayName: 'Member', rank: 1 }, { id: '10', displayName: 'Driver', rank: 10 },
    { id: '20', displayName: 'Mechanic', rank: 20 }, { id: '100', displayName: 'Host', rank: 100 }, { id: '255', displayName: 'Owner', rank: 255 }]
const memberships = new Map<number, string[]>([[1, ['255']], [2, ['1', '20']], [4, ['100']]])
let observed = structuredClone(memberships), delayed = false, writes: string[] = [], failReads = false, rejectWrites = false
let oauthSub = '1', oauthScope = 'openid profile group:read group:write', refreshes = 0, omitScope = false
let introspectionFails = false
let introspectionScope: string | null = null
const rolePath = (id: string) => `groups/99900001/roles/${id}`
const jwt = () => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: oauthSub, preferred_username: 'TestOwner' })).toString('base64url')}.test`
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return realFetch(input, init)
    if (input instanceof Request) init = { method: input.method, headers: input.headers,
        ...(!['GET', 'HEAD'].includes(input.method) ? { body: await input.clone().text() } : {}), ...init }
    if (url.hostname === 'apis.roblox.com' && url.pathname === '/oauth/v1/token') {
        const body = input instanceof Request ? await input.clone().text() : String(init?.body)
        if (body.includes('refresh_token')) { refreshes++; await Bun.sleep(100) }
        return Response.json({ access_token: 'mock-write-refreshed', refresh_token: 'mock-refresh-next', expires_in: 900, token_type: 'Bearer', ...(!omitScope ? { scope: oauthScope } : {}), id_token: jwt() })
    }
    if (url.hostname === 'apis.roblox.com' && url.pathname === '/oauth/v1/userinfo') return Response.json({ sub: oauthSub, created_at: Math.floor((Date.now() - 90 * 86400_000) / 1000) })
    if (url.hostname === 'apis.roblox.com' && url.pathname === '/oauth/v1/token/introspect') {
        return introspectionFails ? new Response('', { status: 503 })
            : Response.json({ active: true, sub: oauthSub, client_id: 'claimable-test', scope: introspectionScope ?? oauthScope })
    }
    if (url.hostname !== 'apis.roblox.com') throw new Error('External provider disabled in the claimable fixture')
    if (failReads && (!init?.method || init.method === 'GET')) return new Response('', { status: 429 })
    if (url.pathname.endsWith('/roles')) return Response.json({ groupRoles: roles })
    if (url.pathname.endsWith('/memberships')) {
        const uid = Number(url.searchParams.get('filter')?.match(/users\/(\d+)/)?.[1])
        const ids = observed.get(uid)
        return Response.json({ groupMemberships: ids ? [{ path: `groups/99900001/memberships/${uid}`, user: `users/${uid}`, role: rolePath(ids.reduce((a, b) => Number(a) > Number(b) ? a : b)), roles: ids.map(rolePath) }] : [] })
    }
    if (url.pathname.includes(':assignRole') || url.pathname.includes(':unassignRole')) {
        if (rejectWrites) return new Response('', { status: 403 })
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-write-refreshed')
        const uid = Number(url.pathname.match(/memberships\/(\d+)/)?.[1]), role = JSON.parse(String(init?.body)).role.split('/').at(-1)
        writes.push(url.pathname)
        const current = memberships.get(uid)!
        if (url.pathname.includes(':unassignRole')) memberships.set(uid, current.filter(id => id !== role))
        else memberships.set(uid, [...new Set([...current, role])])
        if (!delayed) observed = structuredClone(memberships)
        return Response.json({})
    }
    if (url.pathname.endsWith('/groups/99900001')) return Response.json({ id: '99900001', displayName: 'Claimable Test', owner: 'users/1', memberCount: 3 })
    throw new Error(`Unexpected mock provider request ${url.pathname}`)
}) as typeof fetch
const { app } = await import('../src/index')
const worker = process.argv.includes('--worker')
    ? await (await import('./claimables-worker-fixture')).startClaimableWorker(realFetch, globalThis.fetch) : null
const handle = (request: Request) => worker ? worker.handle(request) : app.handle(request)
const { default: db, client } = await import('../src/db')
const { users, groups, rankRelations, sessions, claimableRanks, auditMessages, claimableConnections } = await import('../src/db/schema')
const { encryptSecret } = await import('../src/utils/crypto')
const { hashToken } = await import('../src/utils/sessionVerifier')
const { dataRedis, deleteByPattern } = await import('../src/utils/redis')
const { storeUserTokens, userCredentials } = await import('../src/utils/robloxCredentials')
const { Session } = await import('../src/auth/service')
const userId = crypto.randomUUID(), memberId = crypto.randomUUID(), outsiderId = crypto.randomUUID(), narrowId = crypto.randomUUID(), groupId = crypto.randomUUID()
const ownerToken = crypto.randomUUID(), memberToken = crypto.randomUUID(), outsiderToken = crypto.randomUUID(), narrowToken = crypto.randomUUID()
async function call(path: string, method = 'GET', body?: unknown, token: string | null = ownerToken, origin = 'http://localhost:54100') {
    const response = await handle(new Request('http://localhost:54101' + path, { method, headers: {
        ...(token ? { cookie: `access_token=${token}` } : {}), origin, ...(body ? { 'content-type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    const text = await response.text()
    const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text
    return { status: response.status, data, headers: response.headers }
}
async function expectStatus(path: string, status: number, method = 'GET', body?: unknown, token: string | null = ownerToken) {
    const result = await call(path, method, body, token)
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`)
    return result.data
}
async function clearLimits() { await deleteByPattern('ratelimit:*') }
try {
    await db.insert(users).values([
        { id: userId, robloxId: 1, cachedUsername: 'TestOwner', cachedAt: new Date() },
        { id: memberId, robloxId: 2, cachedUsername: 'TestMember', cachedAt: new Date(), robloxCreatedAt: new Date(Date.now() - 60 * 86400_000) },
        { id: outsiderId, robloxId: 3, cachedUsername: 'TestOutsider', cachedAt: new Date() },
        { id: narrowId, robloxId: 4, cachedUsername: 'TestHost', cachedAt: new Date() }
    ])
    for (const [user, token] of [[userId, ownerToken], [memberId, memberToken], [outsiderId, outsiderToken], [narrowId, narrowToken]]) {
        await db.insert(sessions).values({ sessionId: hashToken(token!), userId: user!, expiresAt: new Date(Date.now() + 86400_000) })
        await storeUserTokens(user!, new OAuth2Tokens({ access_token: 'mock-read', expires_in: 900, scope: 'openid profile group:read' }))
    }
    await storeUserTokens(userId, new OAuth2Tokens({ access_token: 'mock-write-refreshed', refresh_token: 'mock-refresh', expires_in: 900, scope: oauthScope }), [], true)
    await db.insert(groups).values({ id: groupId, robloxId: '99900001', slug: 'claimable-test', visibility: 'PUBLIC', cachedName: 'Claimable Test', cachedAt: new Date(), cachedMembers: 3 })
    const ranks = await db.insert(rankRelations).values(roles.map(role => ({ groupId, robloxId: role.id, cachedName: role.displayName, cachedRank: role.rank,
        permissions: role.rank === 255 ? (1 << 15) : role.rank === 100 ? (1 << 20) | 1 : 0, permissionLevel: role.rank === 255 ? 3 : role.rank === 100 ? 2 : 0 }))).returning()
    const driver = ranks.find(rank => rank.robloxId === '10')!, owner = ranks.find(rank => rank.robloxId === '255')!
    const query = `?groupId=${groupId}`
    await expectStatus('/claimables' + query, 401, 'GET', undefined, null)
    await expectStatus('/claimables' + query, 403, 'GET', undefined, memberToken)
    assert.equal((await call('/claimables', 'POST', { groupId, name: 'Driver', rankId: driver.id }, ownerToken, 'https://evil.example')).status, 403)
    await expectStatus('/claimables/connection', 200, 'POST', { groupId })
    await expectStatus('/claimables', 400, 'POST', { groupId, name: 'Owner', rankId: owner.id })
    const claim = await expectStatus('/claimables', 200, 'POST', { groupId, name: 'Become a Driver', rankId: driver.id })
    const path = '/claimables/' + claim.id
    assert.equal(claim.enabled, false); assert.equal(claim.color, driver.color); assert.equal(claim.maximumRank, 10)
    await expectStatus('/public/groups/claimable-test/claimables/' + claim.slug, 404, 'GET', undefined, null)
    await expectStatus(path, 200, 'PATCH', { enabled: true, maximumRank: 20, minimumAccountAgeDays: 30, requireDiscord: true, translations: { name: { de: 'Fahrer werden' }, forbidden: { de: 'Hidden' } } })
    const translated = await expectStatus('/public/groups/claimable-test/claimables/' + claim.slug, 200, 'GET', undefined, null)
    assert.deepEqual(translated.translations, { name: { de: 'Fahrer werden' } })
    const standing = await expectStatus(path + '/me', 200, 'GET', undefined, memberToken)
    assert.equal(standing.member, true); assert.equal(standing.age, true); assert.equal(standing.discord, false); assert.equal(standing.canClaim, false)
    await expectStatus(path + '/claim', 403, 'POST', undefined, memberToken)
    await expectStatus(path + '/claim', 403, 'POST', undefined, outsiderToken)
    await db.update(users).set({ discordId: 'mock-discord' }).where(eq(users.id, memberId))
    delayed = true
    const result = await expectStatus(path + '/claim', 200, 'POST', undefined, memberToken)
    assert.equal(result.state, 'PENDING'); assert.equal(writes.length, 2)
    assert.equal((await expectStatus(path + '/status', 200, 'GET', undefined, memberToken)).state, 'PENDING')
    await expectStatus(path + '/claim', 200, 'POST', undefined, memberToken); assert.equal(writes.length, 2)
    observed = structuredClone(memberships)
    assert.equal((await expectStatus(path + '/status', 200, 'GET', undefined, memberToken)).state, 'CONFIRMED')
    assert.equal((await expectStatus(path + '/status', 200, 'GET', undefined, memberToken)).state, 'CONFIRMED')
    assert.deepEqual(memberships.get(2), ['1', '10'])
    const audit = await db.select().from(auditMessages).where(eq(auditMessages.groupId, groupId))
    assert.equal(audit.filter(row => row.action === 'claimable.claim').length, 1)
    // Ordinary login is read-only and leaves explicit write consent untouched.
    const login = await call('/auth/login?json=true')
    const loginData = typeof login.data === 'string' ? JSON.parse(login.data) : login.data
    assert.ok(login.headers.get('content-type')?.includes('application/json'))
    assert.equal(new URL(loginData.url).searchParams.get('scope'), 'openid profile group:read')
    assert.equal(new URL(loginData.url).searchParams.has('prompt'), false)
    await storeUserTokens(userId, new OAuth2Tokens({ access_token: 'mock-read-new', expires_in: 900, scope: 'openid profile group:read' }))
    assert.equal((await userCredentials(userId, true)).accessToken, 'mock-write-refreshed')
    assert.equal((await expectStatus('/claimables/connection' + query, 200)).hasWriteScope, true)
    // Reverification verifies identity before storing any privileged token.
    const reverify = await call('/auth/claimables/reverify', 'POST', { groupId })
    assert.equal(reverify.status, 200)
    assert.ok(reverify.headers.get('content-type')?.includes('application/json'))
    const authUrl = new URL(reverify.data.url), state = authUrl.searchParams.get('state')!
    assert.ok(authUrl.searchParams.get('scope')?.includes('group:write'))
    assert.equal(authUrl.searchParams.get('prompt'), 'consent')
    oauthSub = '2'
    assert.deepEqual(await Session.VerifyOAuth('mock-code', state, 'mock-verifier', state, userId), { wrongAccount: true })
    oauthSub = '1'; oauthScope = 'openid profile group:read'
    assert.deepEqual(await Session.VerifyOAuth('mock-code', state, 'mock-verifier', state, userId), { scopeDenied: true })
    oauthScope += ' group:write'
    assert.deepEqual(await Session.VerifyOAuth('mock-code', state, 'mock-verifier', state, userId), { reverified: true })
    await db.update(users).set({ siteRank: 'admin' }).where(eq(users.id, userId))
    await db.update(sessions).set({ adminMode: true }).where(eq(sessions.sessionId, hashToken(ownerToken)))
    const cookies = reverify.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') + `; access_token=${ownerToken}`
    const callback = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${state}`, { headers: { cookie: cookies } }))
    assert.equal(callback.status, 303)
    assert.equal(new URL(callback.headers.get('location')!).searchParams.get('roblox'), 'verified')
    assert.ok(!callback.headers.getSetCookie().some(cookie => cookie.startsWith('access_token=')))
    assert.equal((await expectStatus('/auth/session', 200)).user.adminMode, true)
    // OAuth may omit scope when the granted set is identical to the request.
    const noScope = await call('/auth/claimables/reverify', 'POST', { groupId })
    const noScopeState = new URL(noScope.data.url).searchParams.get('state')!
    const noScopeCookies = noScope.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') + `; access_token=${ownerToken}`
    omitScope = true
    const noScopeCallback = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${noScopeState}`, { headers: { cookie: noScopeCookies } }))
    assert.equal(new URL(noScopeCallback.headers.get('location')!).searchParams.get('roblox'), 'verified')
    assert.equal((await expectStatus('/claimables/connection' + query, 200)).hasWriteScope, true)
    // Omitted scopes still fail closed when Roblox cannot verify the token.
    introspectionFails = true
    assert.deepEqual(await Session.VerifyOAuth('mock-code', state, 'mock-verifier', state, userId), { scopeCheckFailed: true })
    introspectionFails = false
    omitScope = false
    const priorToken = (await db.select().from(users).where(eq(users.id, userId)))[0]!.robloxWriteAccessToken
    for (const reason of ['scope-denied', 'scope-check-failed'] as const) {
        const attempt = await call('/auth/claimables/reverify', 'POST', { groupId })
        const attemptState = new URL(attempt.data.url).searchParams.get('state')!
        const attemptCookies = attempt.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') + `; access_token=${ownerToken}`
        oauthScope = reason === 'scope-denied' ? 'openid profile group:read' : 'openid profile group:read group:write'
        omitScope = reason === 'scope-check-failed'; introspectionFails = omitScope
        const response = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${attemptState}`, { headers: { cookie: attemptCookies } }))
        assert.equal(new URL(response.headers.get('location')!).searchParams.get('roblox'), reason)
        assert.equal((await db.select().from(users).where(eq(users.id, userId)))[0]!.robloxWriteAccessToken, priorToken)
    }
    omitScope = false; introspectionFails = false; oauthScope = 'openid profile group:read group:write'
    // The authoritative grant must survive storage and later token rotation.
    const conflicting = await call('/auth/claimables/reverify', 'POST', { groupId })
    const conflictingState = new URL(conflicting.data.url).searchParams.get('state')!
    const conflictingCookies = conflicting.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') + `; access_token=${ownerToken}`
    introspectionScope = oauthScope; oauthScope = 'openid profile group:read'
    const conflictingCallback = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${conflictingState}`, { headers: { cookie: conflictingCookies } }))
    assert.equal(new URL(conflictingCallback.headers.get('location')!).searchParams.get('roblox'), 'verified')
    assert.equal((await expectStatus('/claimables/connection' + query, 200)).hasWriteScope, true)
    // A missing parked reverification can never silently become a new login.
    const expired = await call('/auth/claimables/reverify', 'POST', { groupId })
    const expiredState = new URL(expired.data.url).searchParams.get('state')!
    await dataRedis.del(`roblox:reverify:${expiredState}`)
    const expiredCookies = expired.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') + `; access_token=${ownerToken}`
    const expiredCallback = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${expiredState}`, { headers: { cookie: expiredCookies } }))
    assert.equal(new URL(expiredCallback.headers.get('location')!).searchParams.get('roblox'), 'expired')
    const missingCookie = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${expiredState}`,
        { headers: { cookie: `access_token=${ownerToken}; roblox_return_to=${encodeURIComponent('/dashboard/claimable-test/claimables')}` } }))
    assert.equal(new URL(missingCookie.headers.get('location')!).searchParams.get('roblox'), 'state-missing')
    const mismatch = await handle(new Request(`http://localhost:54101/auth/callback?code=mock-code&state=${expiredState}`,
        { headers: { cookie: expiredCookies.replace(expiredState, 'claimables-another-state') } }))
    assert.equal(new URL(mismatch.headers.get('location')!).searchParams.get('roblox'), 'state-mismatch')
    await db.update(users).set({ siteRank: 'user' }).where(eq(users.id, userId))
    await db.update(sessions).set({ adminMode: false }).where(eq(sessions.sessionId, hashToken(ownerToken)))
    // Token rotation has one winner, and preserves actually granted scopes.
    await db.update(users).set({ robloxWriteTokenExpiresAt: new Date(0), robloxWriteRefreshToken: await encryptSecret('mock-refresh') }).where(eq(users.id, userId))
    const refreshed = await Promise.all([userCredentials(userId, true), userCredentials(userId, true), userCredentials(userId, true)])
    assert.equal(refreshes, 1); assert.ok(refreshed.every(result => result.accessToken === 'mock-write-refreshed'))
    assert.equal((await expectStatus('/claimables/connection' + query, 200)).hasWriteScope, true)
    oauthScope = introspectionScope!; introspectionScope = null
    // Privileged grants never substitute for Roblox membership/age qualifications.
    failReads = true
    assert.equal((await expectStatus(path + '/me', 200, 'GET', undefined, memberToken)).canClaim, false)
    failReads = false
    await expectStatus(path, 403, 'PATCH', { maximumRank: 100 }, narrowToken)
    await db.update(groups).set({ visibility: 'PRIVATE' }).where(eq(groups.id, groupId))
    await expectStatus(path + '/me', 404, 'GET', undefined, memberToken)
    await expectStatus(path + '/claim', 404, 'POST', undefined, memberToken)
    await db.update(groups).set({ visibility: 'PUBLIC' }).where(eq(groups.id, groupId))
    await clearLimits()
    memberships.set(2, ['1', '20']); observed = structuredClone(memberships); delayed = false; rejectWrites = true
    await expectStatus(path + '/claim', 503, 'POST', undefined, memberToken)
    rejectWrites = false
    memberships.set(1, ['1']); observed = structuredClone(memberships)
    await expectStatus(path + '/claim', 503, 'POST', undefined, memberToken)
    memberships.set(1, ['255']); observed = structuredClone(memberships)
    // A narrow editor cannot offer a lower Roblox rank with grants they cannot give.
    await db.update(rankRelations).set({ permissions: 1 << 15 }).where(eq(rankRelations.id, driver.id))
    await expectStatus(path, 403, 'PATCH', { name: 'Unsafe' }, narrowToken)
    // A stored offer must also respect the connected writer's current grants.
    await storeUserTokens(narrowId, new OAuth2Tokens({ access_token: 'mock-write', expires_in: 900, scope: oauthScope }), [], true)
    await expectStatus('/claimables/connection', 200, 'POST', { groupId }, narrowToken)
    await expectStatus(path + '/claim', 503, 'POST', undefined, memberToken)
    await expectStatus('/claimables/connection', 200, 'POST', { groupId })
    await db.update(rankRelations).set({ permissions: 0 }).where(eq(rankRelations.id, driver.id))
    await db.delete(rankRelations).where(eq(rankRelations.id, driver.id))
    await expectStatus('/public/groups/claimable-test/claimables/' + claim.slug, 404, 'GET', undefined, null)
    console.log('Claimable API: permissions, CSRF, eligibility, role replacement, delayed confirmation, audit idempotency, OAuth scope/identity, token rotation, failure and visibility checks passed.')
    if (process.argv.includes('--serve')) {
        const replacement = await db.insert(rankRelations).values({ groupId, robloxId: '10', cachedName: 'Driver', cachedRank: 10 }).returning()
        await db.update(claimableRanks).set({ rankId: replacement[0]!.id }).where(eq(claimableRanks.id, claim.id))
        await db.insert(claimableConnections).values({ groupId, authorizedBy: userId }).onConflictDoNothing()
        memberships.set(2, ['1', '20']); observed = structuredClone(memberships); delayed = false
        await clearLimits()
        await Bun.write('/tmp/trptools-claimable-fixture.json', JSON.stringify({ groupId, ownerToken, memberToken, outsiderToken, claimId: claim.id, claimSlug: claim.slug }))
        app.listen({ port: 54101, hostname: '127.0.0.1' })
        console.log('Claimable UI fixture listening on localhost:54101')
        await new Promise(() => {})
    }
} finally {
    await worker?.stop()
    globalThis.fetch = realFetch
    await db.delete(groups).where(eq(groups.id, groupId))
    for (const id of [userId, memberId, outsiderId, narrowId]) await db.delete(users).where(eq(users.id, id))
    await client?.end()
}
// The imported API keeps its Redis connections open for ordinary server use.
process.exit(0)
