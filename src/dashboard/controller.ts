import { Elysia } from 'elysia'
import { DashboardModel } from './model'
import { Dashboard } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const dashboard = new Elysia({ prefix: '/dashboard', tags: ['Dashboard'] })
    .use(sessionPlugin)

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
