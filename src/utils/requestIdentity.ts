const peerAddresses = new WeakMap<Request, string>()
export function registerPeerAddress(request: Request, address: string | undefined) {
    if (address) peerAddresses.set(request, address)
}

/** Forwarded headers are trusted only at the Cloudflare edge or by explicit configuration. */
export function clientKey(request: Request, cloudflareWorker: boolean, trustProxy = false): string {
    if (cloudflareWorker || trustProxy) {
        const cloudflareIp = request.headers.get('cf-connecting-ip')
        if (cloudflareIp) return cloudflareIp
    }

    if (!cloudflareWorker && trustProxy) {
        const forwarded = request.headers.get('x-forwarded-for')
        if (forwarded) return forwarded.split(',')[0]!.trim()
        const real = request.headers.get('x-real-ip')
        if (real) return real
    }

    return peerAddresses.get(request) ?? 'unknown'
}

/** The internal route has its own limit only after presenting its service credential. */
export function isBotServiceRequest(request: Request, serviceToken: string): boolean {
    if (!serviceToken || !new URL(request.url).pathname.startsWith('/bot/internal/')) return false
    const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim())
    return match?.[1] === serviceToken
}
