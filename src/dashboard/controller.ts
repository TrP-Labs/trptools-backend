import { Elysia, status, t } from 'elysia'
import { Session } from '../auth/service'
import { Group_ } from '../groups/service'
import { DashboardModel } from './model'
import { Dashboard } from './service'
import { groupOverview } from './group'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const dashboard = new Elysia({ prefix: '/dashboard', tags: ['Dashboard'] })
    .use(sessionPlugin)

    .get('/home', async ({ session }) => {
        const described = await Session.Describe(session)
        if (!described.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
        return { user: described.user, dashboard: await Dashboard.get(session) }
    }, {
        response: { 200: DashboardModel.homeResponse, 401: globalModel.unauthorized },
        detail: { summary: 'Identity and signed-in home data in one request' }
    })

    .get('/groups', async ({ session }) => {
        const described = await Session.Describe(session)
        if (!described.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
        return { user: described.user, groups: await Group_.getGroups(session) }
    }, {
        response: { 200: DashboardModel.groupsPageResponse, 401: globalModel.unauthorized },
        detail: { summary: 'Identity and dashboard group list in one request' }
    })

    .get('/group/:groupId', async ({ params, session }) => {
        const described = await Session.Describe(session)
        if (!described.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
        return { user: described.user, ...await groupOverview(params.groupId, session) }
    }, {
        params: t.Object({ groupId: t.String() }),
        response: {
            200: DashboardModel.groupPageResponse, 401: globalModel.unauthorized,
            403: globalModel.forbidden, 404: globalModel.notFound
        },
        detail: { summary: 'Identity, group and overview summaries in one request' }
    })

    .get('/shifts', async ({ session }) => {
        const described = await Session.Describe(session)
        if (!described.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
        return { user: described.user, ...await Dashboard.shifts(session) }
    }, {
        response: { 200: DashboardModel.shiftsPageResponse, 401: globalModel.unauthorized },
        detail: { summary: 'Identity and shifts across every member group in one request' }
    })

    .get('/', async ({ session }) => Dashboard.get(session), {
        response: {
            200: DashboardModel.dashboardResponse,
            401: globalModel.unauthorized
        },
        detail: {
            summary: 'Everything the signed-in home page shows',
            description:
                'The groups you can act in, your next shifts across all of them, and the application forms ' +
                'waiting on a decision. Only groups you hold a rank in appear — a site admin sees the whole ' +
                'instance here only while admin mode is on.'
        }
    })
