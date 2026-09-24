import { expect, test } from 'bun:test'
import { cachedDiscordRead, DiscordError } from './discordCache'

function fakeCache() {
    const values = new Map<string, string>()
    return {
        values,
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value); return 'OK' },
        del: async (...keys: string[]) => { keys.forEach((key) => values.delete(key)); return keys.length }
    }
}

test('a Discord 429 reuses the last good response without caching an empty result', async () => {
    const cache = fakeCache()
    cache.values.set('stale:discord:roles:one', JSON.stringify([{ id: 'role' }]))
    expect(await cachedDiscordRead<Array<{ id: string }>>('discord:roles:one',
        async () => { throw new DiscordError(429, 'rate limited') }, () => [], cache)
    ).toEqual([{ id: 'role' }])
    expect(cache.values.has('discord:roles:one')).toBe(false)
})

test('a real 404 clears stale data and caches the missing result', async () => {
    const cache = fakeCache()
    cache.values.set('stale:discord:guild:two', JSON.stringify({ id: 'old' }))
    expect(await cachedDiscordRead('discord:guild:two',
        async () => { throw new DiscordError(404, 'missing') }, () => null, cache)
    ).toBeNull()
    expect(cache.values.has('stale:discord:guild:two')).toBe(false)
    expect(cache.values.get('discord:guild:two')).toBe('null')
})

test('a transient failure with no known good data stays an error', async () => {
    const cache = fakeCache()
    await expect(cachedDiscordRead('discord:guild:three',
        async () => { throw new DiscordError(429, 'rate limited') }, () => null, cache)
    ).rejects.toBeInstanceOf(DiscordError)
})

test('concurrent misses share one Discord request', async () => {
    const cache = fakeCache()
    let calls = 0
    const load = async () => { calls++; return { id: 'same' } }
    const results = await Promise.all(Array.from({ length: 4 }, () =>
        cachedDiscordRead('discord:guild:four', load, () => null, cache)))
    expect(calls).toBe(1)
    expect(results.every((value) => value?.id === 'same')).toBe(true)
})
