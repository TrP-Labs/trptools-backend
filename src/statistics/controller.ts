import { Elysia, status, t } from 'elysia'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'
import { env } from '../utils/env'
import { finishRequestCleanup } from '../utils/requestLifetime'
import { rateLimit, clientKey } from '../utils/ratelimit'
import { StatisticsModel } from './model'
import { collectStatistics } from './collector'
import { groupStatistics } from './service'
export const statisticsCollector = new Elysia({ prefix: '/statistics', tags: ['Statistics'] })
    .post('/events', async ({ request, body, set }) => {
        const origin = request.headers.get('origin')?.replace(/\/$/, '')
        if (!origin || !env.FRONTEND_URLS.includes(origin)) throw status(403, 'Forbidden')
        if (!env.isCloudflareWorker) await rateLimit('statistics', clientKey(request), 60, 60)
        // No session/Roblox/Redis lookup at the edge. The background INSERT validates
        // visibility in SQL; the page and the acknowledgement never wait on storage.
        const pending = collectStatistics(body).catch(error => console.error('[statistics] collection failed', error instanceof Error ? error.message : 'unknown'))
        finishRequestCleanup(request, pending)
        set.status = 202
        set.headers['cache-control'] = 'no-store'
        return 'Accepted'
    }, { body: StatisticsModel.batch, response: { 202: t.Literal('Accepted') }, detail: { summary: 'Queue anonymous page counters' } })
export const statistics = new Elysia({ prefix: '/statistics', tags: ['Statistics'] })
    .use(sessionPlugin)
    .get('/groups/:groupId', ({ params, query, session }) => groupStatistics(params.groupId, Number(query.days ?? 30), session), {
        params: t.Object({ groupId: t.String({ maxLength: 48 }) }),
        query: t.Object({ days: t.Optional(t.Union([t.Literal('7'), t.Literal('30'), t.Literal('90')])) }),
        response: { 200: StatisticsModel.response, 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound }, detail: { summary: 'Read a group’s aggregate statistics' }
    })
