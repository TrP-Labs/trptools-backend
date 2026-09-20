export type UpstashCredentials = { url: string; token: string }

/** Resolve Worker REST credentials without ever logging either secret. */
export function resolveUpstashCredentials(
    restUrl: string,
    restToken: string,
    redisUrl: string
): UpstashCredentials | null {
    if (restUrl && restToken) return { url: restUrl, token: restToken }

    try {
        const url = new URL(redisUrl)
        if (url.hostname.endsWith('.upstash.io') && url.password) {
            return { url: `https://${url.hostname}`, token: decodeURIComponent(url.password) }
        }
    } catch {
        return null
    }

    return null
}
