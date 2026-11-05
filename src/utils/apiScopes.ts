/**
 * What an API key may be issued, and which part of the API each scope opens.
 *
 * The eight scopes keys were first issued with (`groups`, `routes`,
 * `schedule`, `dispatch`, each read or write) stay valid as umbrellas over
 * the finer scopes that later split out of them, so a key issued before the
 * split keeps reaching exactly what it reached. Nothing new is ever added to
 * an umbrella: attendance, the driver feed and the account reads were never
 * reachable by a key, so they are their own scopes only.
 *
 * Imports nothing, so `apiKeyPolicy.test.ts` can pin it. The frontend mirrors
 * the catalogue in `$lib/utils/apiScopes.ts`; the strings are stored on keys.
 */

export const SCOPE_CATEGORIES = [
    {
        id: 'groups',
        scopes: ['groups:read', 'groups:write', 'ranks:read', 'ranks:write', 'bot:read', 'bot:write', 'media:read', 'media:write', 'statistics:read']
    },
    {
        id: 'people',
        scopes: ['applications:read', 'applications:write', 'claimables:read', 'claimables:write', 'attendance:read', 'attendance:write']
    },
    { id: 'routes', scopes: ['routes:read', 'routes:write', 'depots:read', 'depots:write'] },
    { id: 'schedule', scopes: ['schedule:read', 'schedule:write', 'signups:read', 'signups:write'] },
    { id: 'dispatch', scopes: ['dispatch:read', 'dispatch:write', 'rooms:read', 'rooms:write', 'host:read', 'host:write'] },
    { id: 'driver', scopes: ['driver:read'] },
    { id: 'account', scopes: ['profile:read', 'dashboard:read', 'notifications:read'] }
] as const

export type ApiScope = (typeof SCOPE_CATEGORIES)[number]['scopes'][number]

export const API_SCOPES: readonly ApiScope[] = SCOPE_CATEGORIES.flatMap((category) => category.scopes)

/** What a key gets when it is created without naming any scope. */
export const DEFAULT_SCOPES: readonly ApiScope[] = ['groups:read', 'routes:read', 'schedule:read']

/**
 * The first path segment, and the resources that may answer for it — its own
 * scope first, then the umbrella it was part of before it split out. `null`
 * means the umbrella has no say there.
 */
const DOMAINS: Record<string, { own: string; umbrella: string | null; readOnly?: boolean }> = {
    groups: { own: 'groups', umbrella: null },
    ranks: { own: 'ranks', umbrella: 'groups' },
    bot: { own: 'bot', umbrella: 'groups' },
    media: { own: 'media', umbrella: 'groups' },
    statistics: { own: 'statistics', umbrella: 'groups' },
    applications: { own: 'applications', umbrella: 'groups' },
    claimables: { own: 'claimables', umbrella: 'groups' },
    attendance: { own: 'attendance', umbrella: null },
    routes: { own: 'routes', umbrella: null },
    depots: { own: 'depots', umbrella: 'routes' },
    schedule: { own: 'schedule', umbrella: null },
    signups: { own: 'signups', umbrella: 'schedule' },
    dispatch: { own: 'dispatch', umbrella: null },
    rooms: { own: 'rooms', umbrella: 'dispatch' },
    host: { own: 'host', umbrella: 'dispatch' },
    driver: { own: 'driver', umbrella: null, readOnly: true },
    dashboard: { own: 'dashboard', umbrella: null, readOnly: true },
    notifications: { own: 'notifications', umbrella: null, readOnly: true }
}

/** The scopes, any one of which lets a key make this request. Empty: none can. */
export function scopesFor(method: string, path: string): string[] {
    const read = method === 'GET' || method === 'HEAD'
    const access = read ? 'read' : 'write'

    if (path === '/auth/session') return read ? ['*'] : []
    // Reading the signed-in person's own profile, preferences, route marks
    // and follows. Changing any of them, and every other /users path, stays
    // browser-only as it always was.
    if (path === '/users/me' || path.startsWith('/users/me/')) return read ? ['profile:read'] : []

    const domain = DOMAINS[path.split('/')[1] ?? '']
    if (!domain || (domain.readOnly && !read)) return []
    const scopes = [`${domain.own}:${access}`]
    if (domain.umbrella) scopes.push(`${domain.umbrella}:${access}`)
    return scopes
}
