import { describe, expect, test } from 'bun:test'
import { OAuth2Tokens } from 'arctic'
import { robloxWriteScopes } from './robloxOAuthScopes'

describe('Roblox write consent', () => {
    const token = (scope?: string) => new OAuth2Tokens({ access_token: 'test-access', ...(scope === undefined ? {} : { scope }) })
    const info = { active: true, client_id: 'test-client', sub: '42', scope: 'openid profile group:read group:write' }
    test('an explicit grant needs no additional provider request', async () => {
        const result = await robloxWriteScopes(token(info.scope), 'test-client', 'test-secret', 42, async () => { throw new Error('Should not fetch') })
        expect(result.state).toBe('VERIFIED')
    })
    test('missing optional scope is verified and persisted from introspection', async () => {
        const result = await robloxWriteScopes(token(), 'test-client', 'test-secret', 42, async (url, init) => {
            expect(url).toBe('https://apis.roblox.com/oauth/v1/token/introspect')
            expect(init?.method).toBe('POST')
            const body = init?.body as URLSearchParams
            expect(body.get('token')).toBe('test-access')
            expect(body.get('client_id')).toBe('test-client')
            expect(body.get('client_secret')).toBe('test-secret')
            return Response.json(info)
        })
        expect(result).toEqual({ state: 'VERIFIED', scopes: info.scope.split(' ') })
    })
    test('read-only response scopes are checked against the actual token', async () => {
        expect(await robloxWriteScopes(token('openid profile group:read'), 'test-client', 'test-secret', 42,
            async () => Response.json({ ...info, scope: 'openid profile group:read' }))).toEqual({ state: 'DENIED', scopes: ['openid', 'profile', 'group:read'] })
        expect(await robloxWriteScopes(token('openid profile group:read'), 'test-client', 'test-secret', 42,
            async () => Response.json(info))).toEqual({ state: 'VERIFIED', scopes: info.scope.split(' ') })
    })
    test('scope parsing handles all OAuth whitespace separators', async () => {
        expect((await robloxWriteScopes(token('openid\tprofile\ngroup:write'), 'test-client', 'test-secret', 42,
            async () => { throw new Error('Should not fetch') })).state).toBe('VERIFIED')
    })
    test('introspection can confirm that write access was not granted', async () => {
        expect((await robloxWriteScopes(token(), 'test-client', 'test-secret', 42,
            async () => Response.json({ ...info, scope: 'openid profile' }))).state).toBe('DENIED')
    })
    for (const invalid of [{ active: false }, { client_id: 'another-app' }, { sub: '43' }, { scope: null }]) {
        test(`untrusted introspection fails closed: ${JSON.stringify(invalid)}`, async () => {
            expect(await robloxWriteScopes(token(), 'test-client', 'test-secret', 42,
                async () => Response.json({ ...info, ...invalid }))).toEqual({ state: 'UNAVAILABLE' })
        })
    }
    test('provider failures remain failures, not consent', async () => {
        expect(await robloxWriteScopes(token(), 'test-client', 'test-secret', 42, async () => new Response('', { status: 503 }))).toEqual({ state: 'UNAVAILABLE' })
        expect(await robloxWriteScopes(token(), 'test-client', 'test-secret', 42, async () => { throw new Error('Network unavailable') })).toEqual({ state: 'UNAVAILABLE' })
    })
})
