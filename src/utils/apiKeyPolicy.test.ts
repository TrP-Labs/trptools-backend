import { expect, test } from 'bun:test'
import { apiKeyAllows } from './apiKeyPolicy'

test('read-only keys cannot mutate any supported domain or mint another key', () => {
    const key = { viaApiKey: true, scopes: ['groups:read', 'routes:read', 'schedule:read', 'dispatch:read'] }
    for (const domain of ['groups', 'ranks', 'bot', 'applications', 'claimables', 'statistics', 'media', 'routes', 'depots', 'schedule', 'signups', 'dispatch', 'rooms', 'host']) {
        expect(apiKeyAllows(key, 'GET', `/${domain}/id`)).toBe(true)
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(apiKeyAllows(key, method, `/${domain}/id`)).toBe(false)
    }
    for (const path of ['/auth/keys', '/auth/logout/all', '/auth/discord/link', '/auth/admin-mode', '/users/me', '/notifications', '/tools/stage', '/new-domain']) {
        expect(apiKeyAllows(key, 'GET', path)).toBe(false)
        expect(apiKeyAllows(key, 'POST', path)).toBe(false)
    }
})

test('scopes are exact and independent, including realtime and room lifecycle', () => {
    const key = { viaApiKey: true, scopes: ['routes:write'] }
    expect(apiKeyAllows(key, 'PATCH', '/routes/id/')).toBe(true)
    expect(apiKeyAllows(key, 'POST', '/depots')).toBe(true)
    expect(apiKeyAllows(key, 'GET', '/routes')).toBe(false)
    expect(apiKeyAllows(key, 'PATCH', '/groups/id')).toBe(false)
    expect(apiKeyAllows(key, 'GET', '/dispatch/id/connect')).toBe(false)
    expect(apiKeyAllows(key, 'POST', '/rooms')).toBe(false)
    expect(apiKeyAllows(key, 'GET', '/%67roups/id')).toBe(false)
    expect(apiKeyAllows(key, 'GET', '/%zz')).toBe(false)
    expect(apiKeyAllows({ viaApiKey: true }, 'GET', '/groups')).toBe(false)
    expect(apiKeyAllows(key, 'GET', '/auth/session')).toBe(true)
    expect(apiKeyAllows(key, 'POST', '/auth/session')).toBe(false)
    expect(apiKeyAllows({}, 'POST', '/auth/keys')).toBe(true)
})
