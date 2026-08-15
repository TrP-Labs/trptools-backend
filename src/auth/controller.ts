import { Elysia, redirect, status, t } from 'elysia'
import { AuthModel } from './model'
import { ApiKeys, Session } from './service'
import { globalModel } from '../utils/globalModel'
import { cookieSecure, env, FRONTEND_URL } from '../utils/env'
import { requireUser, sessionPlugin } from '../utils/authPlugin'
import { clientKey, rateLimit } from '../utils/ratelimit'

const OAUTH_COOKIE_TTL_MS = 1000 * 60 * 10

/** Applied to the login session cookie and both short-lived OAuth cookies. */
const baseCookie = {
    httpOnly: true,
    secure: cookieSecure,
    // The API and the site are separate origins in every deployment we
    // support, so the cookie has to be SameSite=None — which browsers only
    // honour alongside Secure.
    sameSite: cookieSecure ? ('none' as const) : ('lax' as const),
    path: '/',
    domain: env.COOKIE_DOMAIN
}

export const auth = new Elysia({ prefix: '/auth', tags: ['Authentication'] })
    .use(sessionPlugin)

    .get(
        '/login',
        async ({ cookie: { roblox_oauth_state, roblox_code_verifier }, query, request }) => {
            await rateLimit('auth:login', clientKey(request), 20, 60)

            const { url, state, codeVerifier } = await Session.GenerateLogin()
            const expires = new Date(Date.now() + OAUTH_COOKIE_TTL_MS)

            roblox_oauth_state.set({ ...baseCookie, value: state, expires })
            roblox_code_verifier.set({ ...baseCookie, value: codeVerifier, expires })

            if (query.json === 'true') return { url } satisfies AuthModel.LoginUrlResponse

            return redirect(url, 303)
        },
        {
            query: t.Object({ json: t.Optional(t.String()) }),
            detail: { summary: 'Begin Roblox OAuth' }
        }
    )

    .get(
        '/callback',
        async ({ cookie: { roblox_oauth_state, roblox_code_verifier, access_token }, query, request }) => {
            await rateLimit('auth:callback', clientKey(request), 20, 60)

            // The user declined, or Roblox refused the authorization.
            if (query.error || !query.code || !query.state) {
                return redirect(`${FRONTEND_URL}/login?error=denied`, 303)
            }

            const outcome = await Session.VerifyOAuth(
                query.code,
                query.state,
                roblox_code_verifier.value as string | undefined,
                roblox_oauth_state.value as string | undefined
            )

            roblox_oauth_state.remove()
            roblox_code_verifier.remove()

            if ('banned' in outcome) {
                // Only when it lifts, never why — a suspension reason is
                // written for an admin and has no business in a URL.
                const until = outcome.banned.until
                const lifts = until ? `&until=${encodeURIComponent(until.toISOString())}` : ''

                return redirect(`${FRONTEND_URL}/login?error=banned${lifts}`, 303)
            }

            access_token.set({
                ...baseCookie,
                value: outcome.token,
                expires: new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
            })

            return redirect(FRONTEND_URL, 303)
        },
        {
            query: AuthModel.OauthCallbackQuery,
            detail: { summary: 'Roblox OAuth redirect target' }
        }
    )

    .get(
        '/session',
        async ({ session }) => {
            const described = await Session.Describe(session)
            if (!described.authenticated) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
            return described
        },
        {
            response: {
                200: AuthModel.SessionResponse,
                401: globalModel.unauthorized
            },
            detail: { summary: 'Inspect the current session' }
        }
    )

    .post(
        '/logout',
        async ({ cookie: { access_token } }) => {
            await Session.Destroy(access_token.value as string | undefined)
            access_token.remove()
            return 'Success' as globalModel.genericSuccess
        },
        {
            response: { 200: globalModel.genericSuccess },
            detail: { summary: 'End the current session' }
        }
    )

    .post(
        '/logout/all',
        async ({ session, cookie: { access_token } }) => {
            const user = requireUser(session)
            await Session.DestroyAll(user.userId)
            access_token.remove()
            return 'Success' as globalModel.genericSuccess
        },
        {
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized
            },
            detail: { summary: 'End every session for this account' }
        }
    )

    .group('/keys', (app) =>
        app
            .get(
                '/',
                async ({ session }) => ApiKeys.list(requireUser(session).userId),
                {
                    response: {
                        200: AuthModel.ApiKeyList,
                        401: globalModel.unauthorized
                    },
                    detail: { summary: 'List your API keys' }
                }
            )
            .post(
                '/',
                async ({ session, body }) => ApiKeys.create(requireUser(session).userId, body),
                {
                    body: AuthModel.CreateApiKeyBody,
                    response: {
                        200: AuthModel.CreateApiKeyResponse,
                        401: globalModel.unauthorized,
                        409: globalModel.conflict
                    },
                    detail: { summary: 'Create an API key' }
                }
            )
            .delete(
                '/:keyId',
                async ({ session, params: { keyId } }) => {
                    await ApiKeys.revoke(requireUser(session).userId, keyId)
                    return 'Success' as globalModel.genericSuccess
                },
                {
                    params: t.Object({ keyId: t.String({ format: 'uuid' }) }),
                    response: {
                        200: globalModel.genericSuccess,
                        401: globalModel.unauthorized,
                        404: globalModel.notFound
                    },
                    detail: { summary: 'Revoke an API key' }
                }
            )
    )
