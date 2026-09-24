import { dataRedis } from './redis'
import { env } from './env'
import { clientKey as identifyClient } from './requestIdentity'

/** Increment and repair an old counter with no expiry in one Redis operation. */
const INCREMENT_WINDOW = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    ttl = tonumber(ARGV[1])
end
return {count, ttl}
`

export class RateLimitError extends Error {
    constructor(readonly retryAfterSeconds: number) {
        super('Too Many Requests')
    }
}

/**
 * Fixed-window limiter backed by Redis so limits hold across replicas.
 * Fails open: if Redis is unreachable the request is still served.
 */
export async function rateLimit(bucket: string, identifier: string, limit: number, windowSeconds: number) {
    const key = `ratelimit:${bucket}:${identifier}`
    let count = 0
    let ttl = windowSeconds

    try {
        const result = await dataRedis.eval<[number, number]>(INCREMENT_WINDOW, [key], [String(windowSeconds)])
        count = Number(result[0])
        ttl = Number(result[1])
    } catch {
        // Redis problems must not lock users out.
        return
    }

    if (count > limit) throw new RateLimitError(Math.max(1, ttl))
}

/** Best-effort client identity for rate limiting. */
export function clientKey(request: Request): string {
    return identifyClient(request, env.isCloudflareWorker)
}
