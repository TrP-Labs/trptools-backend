type KeySession = { viaApiKey?: boolean; scopes?: string[] }

/** Unscoped account features are browser-only. New domains fail closed for keys. */
export function apiKeyAllows(session: KeySession, method: string, pathname: string): boolean {
    if (!session.viaApiKey) return true
    if (method === 'OPTIONS') return true
    let path: string
    try { path = decodeURIComponent(pathname).replace(/\/+$/, '') }
    catch { return false }
    const read = method === 'GET' || method === 'HEAD'
    if (path === '/auth/session') return read

    const domain = path.split('/')[1]
    const resource = domain === 'groups' || domain === 'ranks' || domain === 'bot' ||
        domain === 'applications' || domain === 'claimables' || domain === 'statistics' || domain === 'media'
        ? 'groups'
        : domain === 'routes' || domain === 'depots' ? 'routes'
        : domain === 'schedule' || domain === 'signups' ? 'schedule'
        : domain === 'dispatch' || domain === 'rooms' || domain === 'host' ? 'dispatch'
        : null
    if (!resource) return false
    return session.scopes?.includes(`${resource}:${read ? 'read' : 'write'}`) ?? false
}
