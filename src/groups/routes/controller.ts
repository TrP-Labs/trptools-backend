import { Elysia, t } from 'elysia'
import { RouteModel } from './model'
import { Depot_, Route_ } from './service'
import { globalModel } from '../../utils/globalModel'
import { sessionPlugin } from '../../utils/authPlugin'

export const route = new Elysia({ prefix: '/routes', tags: ['Routes'] })
    .use(sessionPlugin)

    .get(
        '/',
        async ({ query, session }) => Route_.getAllRoutes(query.groupId, query.includeArchived === 'true', session),
        {
            query: RouteModel.routesRequest,
            response: {
                200: RouteModel.routesResponse,
                404: globalModel.notFound
            },
            detail: { summary: 'List a group\'s routes' }
        }
    )

    .post('/', async ({ body, session }) => Route_.createRoute(body, session), {
        body: RouteModel.createRouteBody,
        response: {
            200: RouteModel.routeIdResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound,
            409: RouteModel.nameTaken
        },
        detail: { summary: 'Create a route' }
    })

    .group('/:routeId', (app) =>
        app
            .get('/', async ({ params: { routeId }, session }) => Route_.getRoute(routeId, session), {
                params: t.Object({ routeId: t.String({ format: 'uuid' }) }),
                response: {
                    200: RouteModel.routeBody,
                    404: globalModel.notFound
                },
                detail: { summary: 'Read a route' }
            })

            .patch('/', async ({ params: { routeId }, body, session }) => Route_.updateRoute(routeId, body, session), {
                params: t.Object({ routeId: t.String({ format: 'uuid' }) }),
                body: RouteModel.patchRouteBody,
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound,
                    409: RouteModel.nameTaken
                },
                detail: {
                    summary: 'Update a route',
                    description: 'Built-in routes accept every change except a rename.'
                }
            })

            .delete('/', async ({ params: { routeId }, session }) => Route_.deleteRoute(routeId, session), {
                params: t.Object({ routeId: t.String({ format: 'uuid' }) }),
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: t.Union([globalModel.forbidden, RouteModel.builtInProtected]),
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Delete a route',
                    description: 'Built-in routes cannot be deleted. Archive them instead.'
                }
            })
    )

export const depot = new Elysia({ prefix: '/depots', tags: ['Depots'] })
    .use(sessionPlugin)

    .get('/', async ({ query, session }) => Depot_.list(query.groupId, query.includeArchived === 'true', session), {
        query: RouteModel.depotQuery,
        response: {
            200: RouteModel.depotList,
            404: globalModel.notFound
        },
        detail: { summary: 'List a group\'s depots' }
    })

    .post('/', async ({ body, session }) => Depot_.create(body, session), {
        body: RouteModel.createDepotBody,
        response: {
            200: t.Object({ id: t.String() }),
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound,
            409: RouteModel.numberTaken
        },
        detail: { summary: 'Create a depot' }
    })

    .get('/:depotId', async ({ params: { depotId }, session }) => Depot_.get(depotId, session), {
        params: t.Object({ depotId: t.String({ format: 'uuid' }) }),
        response: {
            200: RouteModel.depotBody,
            404: globalModel.notFound
        },
        detail: { summary: 'Read a depot' }
    })

    .patch('/:depotId', async ({ params: { depotId }, body, session }) => Depot_.update(depotId, body, session), {
        params: t.Object({ depotId: t.String({ format: 'uuid' }) }),
        body: RouteModel.patchDepotBody,
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound,
            409: RouteModel.numberTaken
        },
        detail: { summary: 'Update a depot' }
    })

    .delete('/:depotId', async ({ params: { depotId }, session }) => Depot_.remove(depotId, session), {
        params: t.Object({ depotId: t.String({ format: 'uuid' }) }),
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Delete a depot' }
    })
