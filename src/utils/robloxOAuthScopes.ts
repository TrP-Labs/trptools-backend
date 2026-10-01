import type { OAuth2Tokens } from 'arctic'

type ScopeResult = { state: 'VERIFIED' | 'DENIED'; scopes: string[] } | { state: 'UNAVAILABLE' }

/** Scope is optional in a successful OAuth response. Verify an omitted scope
 * with Roblox; never infer privileged consent from what we asked for. */
export async function robloxWriteScopes(tokens: OAuth2Tokens, clientId: string, clientSecret: string, robloxId: number,
    request: (input: string, init?: RequestInit) => Promise<Response> = fetch): Promise<ScopeResult> {
    let scopes: string[]
    if (tokens.hasScopes()) scopes = tokens.scopes().filter(Boolean)
    else {
        try {
            const response = await request('https://apis.roblox.com/oauth/v1/token/introspect', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: new URLSearchParams({ token: tokens.accessToken(), client_id: clientId, client_secret: clientSecret }),
                signal: AbortSignal.timeout(10_000), cache: 'no-store'
            })
            if (!response.ok) return { state: 'UNAVAILABLE' }
            const result = await response.json() as { active?: boolean; client_id?: string; sub?: string; scope?: string }
            if (result.active !== true || String(result.client_id) !== clientId || String(result.sub) !== String(robloxId) || typeof result.scope !== 'string') {
                return { state: 'UNAVAILABLE' }
            }
            scopes = result.scope.split(/\s+/).filter(Boolean)
        } catch { return { state: 'UNAVAILABLE' } }
    }
    return { state: scopes.includes('group:write') ? 'VERIFIED' : 'DENIED', scopes }
}
