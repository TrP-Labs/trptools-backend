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

    .get('/groups/:groupId/standings', async ({ params, query, session }) => Attendance.standings(params.groupId, query.period, session), {
        query: t.Object({ period: t.Optional(AttendanceModel.period) }),
        response: { 200: AttendanceModel.standings, 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound },
        detail: {
            summary: 'Everybody’s attendance for a month or a quarter, and who has earned a promotion or a demotion',
            description: 'Points from attendance and sign-ups against each rank’s monthly minimum and maximum, scaled to the period, with the shift-by-shift breakdown behind them. Nothing is changed by reading it.'
        }
    })

    .put('/groups/:groupId/pauses/:robloxId', async ({ params, body, session }) => {
        await rateLimit('attendance:pause', session.user?.userId ?? 'anonymous', 60, 60)
        return Attendance.pause(params.groupId, params.robloxId, body.paused, session)
    }, {
        params: t.Object({ groupId: t.String(), robloxId: t.String({ pattern: '^[0-9]{1,20}$' }) }),
        body: AttendanceModel.pauseBody,
        response: { 200: globalModel.genericSuccess, 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound, 429: globalModel.rateLimited },
        detail: { summary: 'Keep somebody out of the promotion and demotion suggestions, or let them back in' }
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
