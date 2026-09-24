import { expect, test } from 'bun:test'
import { clientKey, isBotServiceRequest } from './requestIdentity'

test('Cloudflare IP takes precedence over a caller-supplied forwarded IP', () => {
    const request = new Request('https://apis.trptools.com/health', {
        headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '192.0.2.99' }
    })
    expect(clientKey(request, true)).toBe('192.0.2.10')
})

test('Worker requests without a trusted client IP cannot choose their own rate-limit key', () => {
    const request = new Request('https://apis.trptools.com/health', {
        headers: { 'x-forwarded-for': '192.0.2.99' }
    })
    expect(clientKey(request, true)).toBe('unknown')
    expect(clientKey(request, false)).toBe('192.0.2.99')
})

test('only an authenticated internal bot request uses the service limit', () => {
    const token = 'service-secret'
    const internal = new Request('https://apis.trptools.com/bot/internal/due/lease', {
        headers: { authorization: `Bearer ${token}` }
    })
    expect(isBotServiceRequest(internal, token)).toBe(true)
    expect(isBotServiceRequest(internal, '')).toBe(false)
    expect(isBotServiceRequest(internal, 'other')).toBe(false)
    expect(isBotServiceRequest(new Request('https://apis.trptools.com/bot/internalish/due/lease', {
        headers: { authorization: `Bearer ${token}` }
    }), token)).toBe(false)
})
