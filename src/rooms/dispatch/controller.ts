import { Elysia, sse, status, t } from 'elysia'
import { Vehicles } from './model'
import { DispatchControls } from './service'
import { canDispatch } from '../service'
import { globalModel } from '../../utils/globalModel'
import { requireUser, sessionPlugin } from '../../utils/authPlugin'
import { hasScope } from '../../utils/sessionVerifier'

export const dispatch = new Elysia({ prefix: '/dispatch', tags: ['Dispatch'] })
    .use(sessionPlugin)

    .group('/:roomId', (app) =>
        app
            /**
             * Every dispatch route needs the same two answers: who is calling,
             * and may they act in this room. Resolving both in one place keeps
             * the handlers thin and makes it impossible to forget the check
             * when a new endpoint is added.
             */
            .resolve({ as: 'scoped' }, async ({ params, session }) => {
                const user = requireUser(session ?? { authenticated: false })
                const roomId = (params as { roomId: string }).roomId

                const room = await canDispatch(user, roomId)
                if (!room) throw status(403, 'Forbidden' satisfies globalModel.forbidden)

                return { user, room, roomId }
            })

            .get('/', async ({ roomId, room, session }) => {
                if (!hasScope(session, 'dispatch:read')) throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                return DispatchControls.getAllVehicles(roomId, room)
            }, {
                response: {
                    200: Vehicles.vehicleList,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: { summary: 'Every vehicle in the room' }
            })

            .get('/presence', async ({ roomId, room, session }) => {
                if (!hasScope(session, 'dispatch:read')) throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                return DispatchControls.presence(roomId, room)
            }, {
                response: {
                    200: Vehicles.presenceList,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Who is in the room',
                    description:
                        'The same people the PRESENCE frame counts, resolved to profiles. The stream carries ids only, so the count stays cheap.'
                }
            })

            .get('/preferences', async ({ roomId, room, session }) => {
                if (!hasScope(session, 'dispatch:read')) throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                return DispatchControls.ownerPreferences(roomId, room)
            }, {
                response: {
                    200: Vehicles.ownerPreferenceList,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Route preferences of the drivers in the room',
                    description:
                        'The same favourites and dislikes the solver honours, so the board can show a dispatcher assigning by hand what automatic assignment would have taken into account.'
                }
            })

            .get('/connect', async function* ({ roomId, user }) {
                for await (const event of DispatchControls.stream(roomId, user.userId)) {
                    yield sse({ data: event })
                }
            }, {
                detail: {
                    summary: 'Realtime vehicle stream',
                    description:
                        'Server-sent events. Opens with a SYNC frame carrying the full vehicle list, then streams ADD, UPDATE, DELETE, PRESENCE and HEARTBEAT frames until the room closes.'
                }
            })

            .post('/vehicles', async ({ roomId, room, body, session }) => {
                if (!hasScope(session, 'dispatch:write')) throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                return DispatchControls.importVehicles(roomId, room, body)
            }, {
                body: Vehicles.importBody,
                response: {
                    200: Vehicles.importResponse,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Sync the room against the game',
                    description:
                        'Adds vehicles that are new and removes vehicles that no longer exist. Existing vehicles keep their dispatch state.'
                }
            })

            .post('/solve', async ({ roomId, room, body, session }) => {
                if (!hasScope(session, 'dispatch:write')) throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                return DispatchControls.solveRoom(roomId, room, body)
            }, {
                body: Vehicles.solveBody,
                response: {
                    200: Vehicles.solveResponse,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Automatically assign routes',
                    description:
                        'Spreads vehicles across the routes their depot serves, honouring capacity and driver route preferences.'
                }
            })

            .group('/vehicle/:vehicleId', (vehicleApp) =>
                vehicleApp
                    .patch('/', async ({ roomId, room, params, body, session }) => {
                        if (!hasScope(session, 'dispatch:write')) {
                            throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                        }
                        return DispatchControls.modifyVehicle(roomId, params.vehicleId, room, body)
                    }, {
                        params: t.Object({ roomId: t.String(), vehicleId: t.String({ maxLength: 32 }) }),
                        body: Vehicles.modifyBody,
                        response: {
                            200: globalModel.genericSuccess,
                            401: globalModel.unauthorized,
                            403: globalModel.forbidden,
                            404: globalModel.notFound,
                            409: Vehicles.towProblem
                        },
                        detail: {
                            summary: 'Update one vehicle',
                            description:
                                'Setting `towing` to another vehicle id records a tow. It is refused if that vehicle has left the room or is already under tow, so two tow trucks cannot claim the same casualty.'
                        }
                    })

                    .delete('/', async ({ roomId, room, params, session }) => {
                        if (!hasScope(session, 'dispatch:write')) {
                            throw status(403, 'Forbidden' satisfies globalModel.forbidden)
                        }
                        return DispatchControls.deleteVehicle(roomId, params.vehicleId, room)
                    }, {
                        params: t.Object({ roomId: t.String(), vehicleId: t.String({ maxLength: 32 }) }),
                        response: {
                            200: globalModel.genericSuccess,
                            401: globalModel.unauthorized,
                            403: globalModel.forbidden,
                            404: globalModel.notFound
                        },
                        detail: { summary: 'Remove a vehicle from the room' }
                    })
            )
    )
