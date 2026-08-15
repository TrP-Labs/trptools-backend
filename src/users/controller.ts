import { Elysia, t } from 'elysia'
import { UserModel } from './model'
import { UserModeration, UserService } from './service'
import { globalModel } from '../utils/globalModel'
import { requireUser, sessionPlugin } from '../utils/authPlugin'
import { clientKey, rateLimit } from '../utils/ratelimit'

export const users = new Elysia({ prefix: '/users', tags: ['Users'] })
    .use(sessionPlugin)

    .get('/me/preferences', async ({ session }) => UserService.getPreferences(session), {
        response: {
            200: UserModel.preferencesResponse,
            401: globalModel.unauthorized,
            404: globalModel.notFound
        },
        detail: { summary: 'Read your preferences' }
    })

    .patch('/me/preferences', async ({ body, session }) => UserService.setPreferences(body, session), {
        body: UserModel.preferencesBody,
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized
        },
        detail: { summary: 'Update your preferences' }
    })

    .get('/me/routes', async ({ session }) => UserService.getRoutePreferences(session), {
        response: {
            200: UserModel.routePreferenceList,
            401: globalModel.unauthorized
        },
        detail: { summary: 'Routes you have marked as favourite or disliked' }
    })

    .put(
        '/me/routes/:routeId',
        async ({ params: { routeId }, body, session }) => UserService.setRoutePreference(routeId, body, session),
        {
            params: t.Object({ routeId: t.String({ format: 'uuid' }) }),
            body: UserModel.setRoutePreferenceBody,
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized,
                404: globalModel.notFound
            },
            detail: {
                summary: 'Mark a route as favourite or disliked',
                description: 'Automatic dispatch assignment prefers favourites and avoids disliked routes.'
            }
        }
    )

    .post(
        '/roblox/resolve',
        async ({ body, session, request }) => {
            // This endpoint reaches out to Roblox on our credentials, so it is
            // gated behind a session and rate limited. Left open it would let
            // anyone use TrPTools as a free Roblox lookup proxy and burn our
            // quota.
            const user = requireUser(session)
            await rateLimit('users:resolve', user.userId || clientKey(request), 60, 60)

            return UserService.resolveRoblox(body)
        },
        {
            body: UserModel.bulkRequest,
            response: {
                200: UserModel.robloxProfileList,
                401: globalModel.unauthorized,
                429: globalModel.rateLimited
            },
            detail: {
                summary: 'Resolve Roblox usernames and avatars in bulk',
                description:
                    'Cached server side so the dispatch table can render owners without hitting Roblox per row.'
            }
        }
    )

    .get('/:userId', async ({ params: { userId }, session }) => UserService.getProfile(userId, session), {
        params: t.Object({ userId: t.String({ format: 'uuid' }) }),
        response: {
            200: UserModel.publicProfile,
            404: globalModel.notFound
        },
        detail: { summary: 'Read a public profile' }
    })

/**
 * Account moderation. Mounted under `/admin` alongside the report queue
 * because it is one portal to the people using it, but the work belongs to
 * this domain rather than to reports.
 */
export const adminUsers = new Elysia({ prefix: '/admin/users', tags: ['Administration'] })
    .use(sessionPlugin)

    .get('/', async ({ query, session }) => UserModeration.list(query, session), {
        query: UserModel.adminListQuery,
        response: {
            200: UserModel.adminUserList,
            401: globalModel.unauthorized,
            403: globalModel.forbidden
        },
        detail: { summary: 'Search accounts' }
    })

    .post('/:userId/ban', async ({ params: { userId }, body, session }) => UserModeration.ban(userId, body, session), {
        params: t.Object({ userId: t.String({ format: 'uuid' }) }),
        body: UserModel.banBody,
        response: {
            200: globalModel.genericSuccess,
            400: UserModel.cannotBanSelf,
            401: globalModel.unauthorized,
            403: t.Union([globalModel.forbidden, UserModel.cannotBanAdmin]),
            404: globalModel.notFound
        },
        detail: {
            summary: 'Suspend or ban an account',
            description:
                'Withdraws access immediately and ends every session the account holds. ' +
                '`durationHours` makes it a suspension that lifts on its own; without it the ban is permanent.'
        }
    })

    .post('/:userId/unban', async ({ params: { userId }, session }) => UserModeration.unban(userId, session), {
        params: t.Object({ userId: t.String({ format: 'uuid' }) }),
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Restore an account' }
    })
