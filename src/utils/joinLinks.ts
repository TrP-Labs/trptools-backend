/** Only Discord's canonical invite surface; never an arbitrary redirect. */
export function normalizeDiscordInvite(value: string): string | null {
    const input = value.trim()
    if (!input) return ''
    if (/^[A-Za-z0-9_-]{2,100}$/.test(input)) return `https://discord.gg/${input}`
    try {
        const url = new URL(input)
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
        const match = url.hostname === 'discord.gg' ? url.pathname.match(/^\/([A-Za-z0-9_-]{2,100})\/?$/)
            : url.hostname === 'discord.com' ? url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{2,100})\/?$/) : null
        return match ? `https://discord.gg/${match[1]}` : null
    } catch { return null }
}
