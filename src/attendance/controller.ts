import { Elysia, t } from 'elysia'
import { sessionPlugin } from '../utils/authPlugin'
import { globalModel } from '../utils/globalModel'
import { rateLimit } from '../utils/ratelimit'
import { AttendanceModel } from './model'
import { Attendance } from './service'

export const attendance = new Elysia({ prefix: '/attendance', tags: ['Ranks'] })
    .use(sessionPlugin)

    .get('/ranks/:rankId', async ({ params, session }) => Attendance.settings(params.rankId, session), {
        params: t.Object({ rankId: t.String({ format: 'uuid' }) }),
        response: { 200: AttendanceModel.settings, 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound },
        detail: { summary: 'A rank’s attendance rules, with every slot it can sign up for' }
    })

    .put('/ranks/:rankId', async ({ params, body, session }) => Attendance.saveSettings(params.rankId, body, session), {
        params: t.Object({ rankId: t.String({ format: 'uuid' }) }),
        body: AttendanceModel.settingsBody,
        response: { 200: globalModel.genericSuccess, 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound },
        detail: { summary: 'Save a rank’s attendance rules' }
    })

    .get('/groups/:groupId/standings', async ({ params, query, session }) => Attendance.standings(params.groupId, query.month, session), {
        query: t.Object({ month: t.Optional(t.String({ pattern: '^[0-9]{4}-[0-9]{2}$' })) }),
        response: { 200: AttendanceModel.standings, 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound },
        detail: {
            summary: 'Who has earned a promotion or a demotion this month',
            description: 'Points from attendance and sign-ups against each rank’s monthly minimum and maximum. Nothing is changed by reading it.'
        }
    })

    .post('/groups/:groupId/apply', async ({ params, body, session }) => {
        await rateLimit('attendance:apply', session.user?.userId ?? 'anonymous', 30, 60)
        return Attendance.apply(params.groupId, body, session)
    }, {
        body: AttendanceModel.applyBody,
        response: {
            200: t.Object({ state: t.Union([t.Literal('CONFIRMED'), t.Literal('PENDING')]) }),
            401: globalModel.unauthorized,
            403: t.Union([globalModel.forbidden, AttendanceModel.unsafe]),
            404: globalModel.notFound,
            409: AttendanceModel.stale,
            429: globalModel.rateLimited,
            503: t.Union([AttendanceModel.unreachable, t.Literal('The group needs to reconnect Roblox rank changes')])
        },
        detail: { summary: 'Promote or demote somebody along the path their attendance earned' }
    })
