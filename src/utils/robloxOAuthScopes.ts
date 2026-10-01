import type { OAuth2Tokens } from 'arctic'

type ScopeResult = { state: 'VERIFIED' | 'DENIED'; scopes: string[] } | { state: 'UNAVAILABLE' }

/** Verify a missing write grant with Roblox's token introspection endpoint.
 * Never infer privileged consent from what we asked for. */
export async function robloxWriteScopes(tokens: OAuth2Tokens, clientId: string, clientSecret: string, robloxId: number,
    request: (input: string, init?: RequestInit) => Promise<Response> = fetch): Promise<ScopeResult> {
    const responseScopes = tokens.hasScopes() ? tokens.scopes().flatMap(scope => scope.split(/\s+/)).filter(Boolean) : null
    if (responseScopes?.includes('group:write')) return { state: 'VERIFIED', scopes: responseScopes }
    let scopes: string[]
    {
        try {
            const response = await request('https://apis.roblox.com/oauth/v1/token/introspect', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: new URLSearchParams({ token: tokens.accessToken(), client_id: clientId, client_secret: clientSecret }),
                signal: AbortSignal.timeout(10_000), cache: 'no-store'
            })
            if (!response.ok) {
                console.warn('[claimables:oauth] scope introspection failed', { clientId, status: response.status })
                return { state: 'UNAVAILABLE' }
            }
            const result = await response.json() as { active?: boolean; client_id?: string; sub?: string; scope?: string }
            if (result.active !== true || String(result.client_id) !== clientId || String(result.sub) !== String(robloxId) || typeof result.scope !== 'string') {
                console.warn('[claimables:oauth] scope introspection could not validate the token', { clientId })
                return { state: 'UNAVAILABLE' }
            }
            scopes = result.scope.split(/\s+/).filter(Boolean)
        } catch {
            console.warn('[claimables:oauth] scope introspection request failed', { clientId })
            return { state: 'UNAVAILABLE' }
        }
    }
    // Permission names and the app's public ID explain a denial without
    // exposing access tokens, client secrets, or account identities.
    const scopeNames = (values: string[] | null) => values?.slice(0, 32).map(value => value.slice(0, 128)) ?? null
    console.info('[claimables:oauth] scope introspection completed', {
        clientId, responseScopes: scopeNames(responseScopes), verifiedScopes: scopeNames(scopes), hasWriteScope: scopes.includes('group:write')
    })
    return { state: scopes.includes('group:write') ? 'VERIFIED' : 'DENIED', scopes }
}
