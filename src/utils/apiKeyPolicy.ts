import { scopesFor } from './apiScopes'

type KeySession = { viaApiKey?: boolean; scopes?: string[] }

/** Unscoped account features are browser-only. New domains fail closed for keys. */
export function apiKeyAllows(session: KeySession, method: string, pathname: string): boolean {
    if (!session.viaApiKey) return true
    if (method === 'OPTIONS') return true
    let path: string
    try { path = decodeURIComponent(pathname).replace(/\/+$/, '') }
    catch { return false }

    const accepted = scopesFor(method, path)
    if (accepted.includes('*')) return true
    return accepted.some((scope) => session.scopes?.includes(scope) ?? false)
}
