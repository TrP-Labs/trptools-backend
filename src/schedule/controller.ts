import { Elysia, t } from 'elysia'
import { ScheduleModel } from './model'
import { Schedule } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const schedule = new Elysia({ prefix: '/schedule', tags: ['Schedule'] })
    .use(sessionPlugin)

    .get('/', async ({ query, session }) => Schedule.getSchedules(query.groupId, session), {
        query: ScheduleModel.eventsRequest,
        response: {
            200: ScheduleModel.eventsResponse,
            404: globalModel.notFound
        },
        detail: { summary: 'List a group\'s recurring shifts' }
    })

    .post('/', async ({ body, session }) => Schedule.createScheduledObject(body, session), {
        body: ScheduleModel.createBody,
        response: {
            200: ScheduleModel.createResponse,
            400: ScheduleModel.invalidRRule,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Create a recurring shift' }
    })

    .get('/occurrences', async ({ query, session }) => Schedule.getOccurrences(query, session), {
        query: ScheduleModel.occurrencesRequest,
        response: {
            200: ScheduleModel.occurrencesResponse,
            400: globalModel.badRequest,
            404: globalModel.notFound
        },
        detail: {
            summary: 'Expand shifts into dated occurrences',
            description: 'Returns concrete shift instances across a window, each with its slots and signups.'
        }
    })

    .post('/signup', async ({ body, session }) => Schedule.signUp(body, session), {
        body: ScheduleModel.signupBody,
        response: {
            200: globalModel.genericSuccess,
            400: globalModel.badRequest,
            401: globalModel.unauthorized,
            403: t.Union([globalModel.forbidden, ScheduleModel.wrongRank]),
            404: globalModel.notFound,
            409: t.Union([ScheduleModel.slotFull, ScheduleModel.alreadySignedUp, ScheduleModel.signupsClosed])
        },
        detail: {
            summary: 'Take a slot on one shift occurrence',
            description:
                'The slot must belong to a sign-up sheet the caller\'s Roblox rank reaches. ' +
                'Managers and site admins may take any slot in their group.'
        }
    })

    .post('/withdraw', async ({ body, session }) => Schedule.withdraw(body, session), {
        body: ScheduleModel.signupBody,
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized
        },
        detail: { summary: 'Give up a slot you took' }
    })

    .delete('/signup/:signupId', async ({ params: { signupId }, session }) => Schedule.removeSignup(signupId, session), {
        params: t.Object({ signupId: t.String({ format: 'uuid' }) }),
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: {
            summary: 'Take somebody off a slot',
            description:
                'Needs the edit sign-ups grant. Giving up your own slot is POST /schedule/withdraw, ' +
                'which asks for no permission at all.'
        }
    })

    .patch(
        '/signup/:signupId',
        async ({ params: { signupId }, body, session }) => Schedule.moveSignup(signupId, body, session),
        {
            params: t.Object({ signupId: t.String({ format: 'uuid' }) }),
            body: ScheduleModel.moveSignupBody,
            response: {
                200: globalModel.genericSuccess,
                400: ScheduleModel.notSameShift,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: globalModel.notFound,
                409: ScheduleModel.slotFull
            },
            detail: {
                summary: 'Move somebody to another slot',
                description:
                    'Within the same group and occurrence. The target slot\'s rank list is not consulted \u2014 ' +
                    'it says who may sign themselves up, not where a host may put somebody.'
            }
        }
    )

    .group('/:eventId', (app) =>
        app
            .get('/', async ({ params: { eventId }, session }) => Schedule.getScheduleObject(eventId, session), {
                params: t.Object({ eventId: t.String({ format: 'uuid' }) }),
                response: {
                    200: ScheduleModel.eventResponse,
                    404: globalModel.notFound
                },
                detail: { summary: 'Read one recurring shift' }
            })

            .patch(
                '/',
                async ({ params: { eventId }, body, session }) => Schedule.updateScheduleObject(eventId, body, session),
                {
                    params: t.Object({ eventId: t.String({ format: 'uuid' }) }),
                    body: ScheduleModel.updateBody,
                    response: {
                        200: globalModel.genericSuccess,
                        400: ScheduleModel.invalidRRule,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: globalModel.notFound
                    },
                    detail: { summary: 'Update a recurring shift' }
                }
            )

            .delete('/', async ({ params: { eventId }, session }) => Schedule.deleteScheduleObject(eventId, session), {
                params: t.Object({ eventId: t.String({ format: 'uuid' }) }),
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: { summary: 'Delete a recurring shift' }
            })
    )
