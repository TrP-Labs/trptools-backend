import { status } from 'elysia'
import { dataRedis } from './redis'

/**
 * Fixed-window limiter backed by Redis so limits hold across replicas.
 * Fails open: if Redis is unreachable the request is still served.
 */
export async function rateLimit(bucket: string, identifier: string, limit: number, windowSeconds: number) {
    const key = `ratelimit:${bucket}:${identifier}`
    let count = 0

    try {
        count = await dataRedis.incr(key)
        if (count === 1) await dataRedis.expire(key, windowSeconds)
    } catch {
        // Redis problems must not lock users out.
        return
    }

    if (count > limit) throw status(429, 'Too Many Requests')
}

/** Best-effort client identity for rate limiting. */
export function clientKey(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0]!.trim()

    const real = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip')
    if (real) return real

    return 'unknown'
}
