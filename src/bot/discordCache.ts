export class DiscordError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly retryAfterSeconds: number | null = null
    ) {
        super(message)
    }
}

const inFlight = new Map<string, Promise<unknown>>()
const CACHE_TTL = 60
const STALE_TTL = 900

type Cache = {
    get(key: string): Promise<string | null>
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
    del(...keys: string[]): Promise<unknown>
}

/** Keep a known good response through brief Discord outages, without caching an outage as "absent". */
export async function cachedDiscordRead<T>(
    key: string, load: () => Promise<T>, missing: () => T,
    cache: Cache
): Promise<T> {
    try {
        const hit = await cache.get(key)
        if (hit !== null) return JSON.parse(hit) as T
    } catch {
        // A Redis outage should not stop the Discord read.
    }

    const current = inFlight.get(key)
    if (current) return current as Promise<T>

    const pending = (async () => {
        try {
            const value = await load()
            const serialized = JSON.stringify(value)
            await Promise.allSettled([
                cache.set(key, serialized, 'EX', CACHE_TTL),
                cache.set(`stale:${key}`, serialized, 'EX', STALE_TTL)
            ])
            return value
        } catch (error) {
            if (error instanceof DiscordError && error.status === 404) {
                const value = missing()
                await Promise.allSettled([
                    cache.set(key, JSON.stringify(value), 'EX', CACHE_TTL),
                    cache.del(`stale:${key}`)
                ])
                return value
            }
            console.warn('[discord] read failed', key, error instanceof Error ? error.message : error)
            const stale = await cache.get(`stale:${key}`).catch(() => null)
            if (stale !== null) return JSON.parse(stale) as T
            throw error
        }
    })()
    inFlight.set(key, pending)
    try { return await pending }
    finally { inFlight.delete(key) }
}
