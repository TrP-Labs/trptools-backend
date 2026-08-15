import { Elysia, status } from 'elysia'
import { ResolveSession, type session } from './sessionVerifier'
import { env } from './env'

/**
 * Attaches `session` to every request and rejects cross-site state changes.
 *
 * Because authentication rides on a cookie, a mutating request that arrives
 * from an origin we do not control is treated as forged. Safe methods and API
 * key callers (which do not carry cookies) are exempt.
 */
export const sessionPlugin = new Elysia({ name: 'trptools/session' })
    .onBeforeHandle({ as: 'scoped' }, ({ request }) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return

        const origin = request.headers.get('origin')
        if (!origin) return
        if (env.FRONTEND_URLS.includes(origin.replace(/\/$/, ''))) return
        if (origin === env.BASE_URL) return

        throw status(403, 'Forbidden')
    })
    .derive({ as: 'scoped' }, async ({ cookie, request }): Promise<{ session: session }> => {
        const session = await ResolveSession(
            cookie.access_token?.value as string | undefined,
            request.headers.get('authorization') ?? undefined
        )

        return { session }
    })

/** Narrows a session to an authenticated one or throws 401. */
export function requireUser(session: session) {
    if (!session.authenticated || !session.user) throw status(401, 'Unauthorized')
    return session.user
}

/** The same narrowing for site admins, who bypass group permissions entirely. */
export function requireSiteAdmin(session: session) {
    const user = requireUser(session)
    if (user.siteRank !== 'admin') throw status(403, 'Forbidden')
    return user
}
