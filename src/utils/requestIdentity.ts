/** Cloudflare owns this header at the public edge. Forwarded headers are only a local fallback. */
export function clientKey(request: Request, cloudflareWorker: boolean): string {
    const cloudflareIp = request.headers.get('cf-connecting-ip')
    if (cloudflareIp) return cloudflareIp

    if (!cloudflareWorker) {
        const forwarded = request.headers.get('x-forwarded-for')
        if (forwarded) return forwarded.split(',')[0]!.trim()
        const real = request.headers.get('x-real-ip')
        if (real) return real
    }

    return 'unknown'
}

/** The internal route has its own limit only after presenting its service credential. */
export function isBotServiceRequest(request: Request, serviceToken: string): boolean {
    if (!serviceToken || !new URL(request.url).pathname.startsWith('/bot/internal/')) return false
    const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim())
    return match?.[1] === serviceToken
}
