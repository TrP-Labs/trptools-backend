import { Elysia, t } from 'elysia'
import { ScheduleModel } from './model'
import { Instances } from './instances'
import { Schedule } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const schedule = new Elysia({ prefix: '/schedule', tags: ['Schedule'] })
    .use(sessionPlugin)

    .get('/instance', async ({ query, session }) => await Instances.resolve(query.groupId, query.slug, query.occurrence, session), {
        query: t.Object({ groupId: t.String(), slug: t.String({ maxLength: 48 }), occurrence: t.Date() }),
        response: { 200: ScheduleModel.instanceResponse, 400: globalModel.badRequest, 404: globalModel.notFound }
    })
    .get('/instances', async ({ query, session }) => await Instances.list(query, session), {
        query: ScheduleModel.instanceQuery, response: { 200: t.Array(ScheduleModel.instanceSummary), 401: globalModel.unauthorized, 403: globalModel.forbidden, 404: globalModel.notFound }
    })
    .get('/instances/:id', async ({ params, session }) => await Instances.get(params.id, session), {
        params: t.Object({ id: t.String({ format: 'uuid' }) }), response: { 200: ScheduleModel.instanceResponse, 400: globalModel.badRequest, 404: globalModel.notFound }
    })
    .patch('/instances/:id', async ({ params, body, session }) => await Instances.update(params.id, body, session), {
        params: t.Object({ id: t.String({ format: 'uuid' }) }), body: ScheduleModel.instancePatch,
        response: { 200: globalModel.genericSuccess, 401: globalModel.unauthorized, 403: t.String(), 404: globalModel.notFound, 409: t.String() }
    })
    .post('/instances/:id/vote', async ({ params, body, session }) => await Instances.vote(params.id, body.attending, session), {
        params: t.Object({ id: t.String({ format: 'uuid' }) }), body: ScheduleModel.voteBody,
        response: { 200: globalModel.genericSuccess, 401: globalModel.unauthorized, 403: t.String(), 404: globalModel.notFound, 409: t.String() }
    })

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
            409: ScheduleModel.tooManyShifts,
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
