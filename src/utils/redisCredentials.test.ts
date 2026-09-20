import { describe, expect, test } from 'bun:test'
import { resolveUpstashCredentials } from './redisCredentials'

describe('resolveUpstashCredentials', () => {
    test('prefers explicit REST credentials', () => {
        expect(resolveUpstashCredentials('https://explicit.upstash.io', 'rest-token', 'redis://ignored')).toEqual({
            url: 'https://explicit.upstash.io',
            token: 'rest-token'
        })
    })

    test('derives REST access from an existing Upstash Redis URL', () => {
        expect(
            resolveUpstashCredentials('', '', 'rediss://default:token%2Fwith%2Fslashes@ready-fox.upstash.io:6379')
        ).toEqual({
            url: 'https://ready-fox.upstash.io',
            token: 'token/with/slashes'
        })
    })

    test('does not reinterpret a local Redis password as an Upstash token', () => {
        expect(resolveUpstashCredentials('', '', 'redis://default:secret@localhost:6379')).toBeNull()
    })

    test('rejects a malformed Redis URL', () => {
        expect(resolveUpstashCredentials('', '', 'not a URL')).toBeNull()
    })
})
