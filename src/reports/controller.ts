import { Elysia, t } from 'elysia'
import { ReportModel } from './model'
import { Reports } from './service'
import { globalModel } from '../utils/globalModel'
import { requireUser, sessionPlugin } from '../utils/authPlugin'
import { rateLimit } from '../utils/ratelimit'
import { REPORT_REASONS } from '../db/schema'

export const reportRoutes = new Elysia({ prefix: '/reports', tags: ['Moderation'] })
    .use(sessionPlugin)

    .get('/reasons', () => [...REPORT_REASONS], {
        response: { 200: t.Array(t.String()) },
        detail: { summary: 'The report reasons offered in the UI' }
    })

    .post(
        '/',
        async ({ body, session }) => {
            const user = requireUser(session)
            // Reporting takes content down instantly, so the rate has to be
            // low enough that it cannot be used as a denial-of-service tool.
            await rateLimit('reports:create', user.userId, 10, 3600)

            return Reports.create(body, session)
        },
        {
            body: ReportModel.createBody,
            response: {
                200: ReportModel.createResponse,
                401: globalModel.unauthorized,
                404: globalModel.notFound,
                409: ReportModel.alreadyReported,
                429: globalModel.rateLimited
            },
            detail: {
                summary: 'Report content',
                description:
                    'Hides the content immediately unless a site admin has already approved it. Limited to 10 reports per account per hour.'
            }
        }
    )

export const adminRoutes = new Elysia({ prefix: '/admin', tags: ['Administration'], detail: { hide : true } })
    .use(sessionPlugin)

    .get('/overview', async ({ session }) => Reports.overview(session), {
        response: {
            200: ReportModel.overview,
            401: globalModel.unauthorized,
            403: globalModel.forbidden
        },
        detail: { summary: 'Site-wide counts' }
    })

    .get('/reports', async ({ query, session }) => Reports.list(query, session), {
        query: ReportModel.listQuery,
        response: {
            200: ReportModel.adminReportList,
            401: globalModel.unauthorized,
            403: globalModel.forbidden
        },
        detail: { summary: 'Review the report queue' }
    })

    .post(
        '/reports/:id/approve',
        async ({ params: { id }, body, session }) => Reports.approve(id, body, session),
        {
            params: t.Object({ id: t.String({ format: 'uuid' }) }),
            body: ReportModel.resolveBody,
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: globalModel.notFound
            },
            detail: {
                summary: 'Clear the content',
                description:
                    'Restores the content and exempts it from future automatic hiding. Later reports are still recorded.'
            }
        }
    )

    .post(
        '/reports/:id/uphold',
        async ({ params: { id }, body, session }) => Reports.uphold(id, body, session),
        {
            params: t.Object({ id: t.String({ format: 'uuid' }) }),
            body: ReportModel.resolveBody,
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: globalModel.notFound
            },
            detail: { summary: 'Leave the content hidden' }
        }
    )
