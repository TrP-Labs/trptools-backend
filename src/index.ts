import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import openapi from '@elysiajs/openapi'
import { env } from './utils/env'
import { clientKey, rateLimit } from './utils/ratelimit'

import { auth } from './auth/controller'
import { adminUsers, users } from './users/controller'
import { group } from './groups/controller'
import { ranks } from './groups/rank/controller'
import { route, depot } from './groups/routes/controller'
import { schedule } from './schedule/controller'
import { rooms } from './rooms/controller'
import { dispatch } from './rooms/dispatch/controller'
import { publicPages } from './public/controller'
import { mediaRoutes } from './media/controller'
import { adminRoutes, reportRoutes } from './reports/controller'
import { tools } from './tools/controller'

export const app = new Elysia()
    .use(
        cors({
            origin: env.FRONTEND_URLS,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
        })
    )
    .onRequest(async ({ request }) => {
        // A broad safety net so no single client can saturate the API. Routes
        // that are individually expensive apply their own tighter limits on
        // top of this.
        await rateLimit('global', clientKey(request), 600, 60)
    })
    .onAfterHandle(({ set }) => {
        // The API only ever answers JSON, so nothing here should be sniffed,
        // framed or referred onward with a full URL.
        set.headers['x-content-type-options'] = 'nosniff'
        set.headers['x-frame-options'] = 'DENY'
        set.headers['referrer-policy'] = 'strict-origin-when-cross-origin'
    })
    .onError(({ code, error, set }) => {
        // A thrown `status(...)` surfaces here with a numeric code. Those are
        // deliberate answers, not failures, so pass them straight through.
        if (typeof code === 'number') {
            set.status = code
            return (error as { response?: unknown })?.response ?? 'Error'
        }

        // A body that fails to parse or validate is the caller's mistake, not
        // ours, and must not be reported as a server fault.
        if (code === 'VALIDATION' || code === 'PARSE') {
            set.status = 400
            return 'Bad Request'
        }

        if (code === 'NOT_FOUND') {
            set.status = 404
            return 'Not Found'
        }

        // Never leak internals to the client; the detail stays in our logs.
        console.error('[error]', code, error instanceof Error ? error.message : error)
        set.status = 500
        return 'Internal Server Error'
    })

    .get('/', () => ({ message: 'TrP Tools API', docs: `${env.BASE_URL}/docs` }), { detail: { hide: true } })
    .get('/health', () => ({ status: 'ok' }), { detail: { hide: true } })

    .use(auth)
    .use(users)
    .use(group)
    .use(ranks)
    .use(route)
    .use(depot)
    .use(schedule)
    .use(rooms)
    .use(dispatch)
    .use(publicPages)
    .use(mediaRoutes)
    .use(reportRoutes)
    .use(adminRoutes)
    .use(adminUsers)
    .use(tools)

    .use(
        openapi({
            path: '/docs',
            documentation: {
                info: {
                    title: 'TrP Tools API',
                    version: '2.0.0',
                    description:
                        'Group management, shift scheduling and multi-user dispatch for TrP.\n\n' +
                        'Authenticate as a user with Roblox OAuth (a session cookie), or as an ' +
                        'integration with a TrPTools API key sent as `Authorization: Bearer <key>`.'
                },
                tags: [
                    { name: 'Authentication', description: 'Roblox OAuth sessions and API keys' },
                    { name: 'Users', description: 'Profiles and personal preferences' },
                    { name: 'Groups', description: 'Group registration, settings and visibility' },
                    { name: 'Ranks', description: 'Mapping Roblox roles to TrPTools permissions' },
                    { name: 'Routes', description: 'Custom routes and depots' },
                    { name: 'Schedule', description: 'Recurring shifts, occurrences and signups' },
                    { name: 'Rooms', description: 'Opening and closing dispatch rooms' },
                    { name: 'Dispatch', description: 'Live vehicle assignment inside a room' },
                    { name: 'Public', description: 'Anonymous reads of published group pages' },
                    { name: 'Depots', description: 'Depot numbers, descriptions and images' },
                    { name: 'Media', description: 'Uploaded images for routes, depots and groups' },
                    { name: 'Moderation', description: 'Reporting user-supplied content' },
                    { name: 'Administration', description: 'Site-wide moderation and account suspension, admins only' },
                    { name: 'Tools', description: 'Stage light programmer storage' }
                ]
            }
        })
    )

export type App = typeof app

if (import.meta.main) {
    app.listen({ port: env.PORT, hostname: env.HOST })
    console.log(`TrP Tools API listening on http://${env.HOST}:${env.PORT}`)
}
