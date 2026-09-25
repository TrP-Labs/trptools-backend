import { clientKey, isBotServiceRequest } from './requestIdentity'

export type WorkerRateLimit = {
    limit(options: { key: string }): Promise<{ success: boolean }>
}

export type WorkerRateLimitBindings = {
    GLOBAL_RATE_LIMIT: WorkerRateLimit
    BOT_RATE_LIMIT: WorkerRateLimit
}

/** Broad abuse protection at the edge, without a billed Redis command per request. */
export async function checkWorkerRateLimit(
    request: Request, bindings: WorkerRateLimitBindings, botServiceToken: string
): Promise<Response | null> {
    const bot = isBotServiceRequest(request, botServiceToken)
    const limiter = bot ? bindings.BOT_RATE_LIMIT : bindings.GLOBAL_RATE_LIMIT
    const key = bot ? 'authenticated' : clientKey(request, true)

    // Like the Redis limiter, an unavailable limiter must not lock users out.
    try {
        if ((await limiter.limit({ key })).success) return null
    } catch {
        return null
    }

    // Cloudflare's API exposes success only; it does not expose the window TTL.
    return new Response('Too Many Requests', {
        status: 429,
        headers: {
            'retry-after': '60',
            'x-ratelimit-source': 'trptools'
        }
    })
}
