const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']

/** Subscription URLs are credentials, never arbitrary outbound destinations. */
export function validPushEndpoint(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
            !url.hash && url.pathname.length > 1 &&
            (PUSH_HOSTS.includes(url.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname))
    } catch { return false }
}

export function validPushKeys(keys: { p256dh: string; auth: string }): boolean {
    const base64 = /^[A-Za-z0-9_-]+={0,2}$/
    try {
        if (!base64.test(keys.p256dh) || !base64.test(keys.auth)) return false
        const decode = (key: string) => atob(key.replace(/-/g, '+').replace(/_/g, '/'))
        const publicKey = decode(keys.p256dh)
        return publicKey.length === 65 && publicKey.charCodeAt(0) === 4 && decode(keys.auth).length === 16
    } catch { return false }
}

export function retryDelay(attempts: number, retryAfter: string | null): number {
    const seconds = Number(retryAfter)
    return Math.min(900, Math.max(30 * 2 ** Math.max(0, attempts - 1), Number.isFinite(seconds) ? seconds : 0))
}
