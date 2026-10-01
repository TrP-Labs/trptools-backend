export function creationDate(profile: { sub?: unknown; created_at?: unknown }, robloxId: number): Date | null {
    if (String(profile.sub) !== String(robloxId) || typeof profile.created_at !== 'number') return null
    const milliseconds = profile.created_at * 1000
    return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= Date.now() ? new Date(milliseconds) : null
}
export async function robloxCreationDate(accessToken: string, robloxId: number): Promise<Date | null> {
    try {
        const response = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store'
        })
        if (!response.ok) return null
        return creationDate(await response.json(), robloxId)
    } catch { return null }
}
