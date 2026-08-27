import { Elysia, t } from 'elysia'
import { ToolsModel } from './model'
import { PersonalDispatch } from './dispatch'
import { StagePrograms } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'
import { clientKey, rateLimit } from '../utils/ratelimit'

export const tools = new Elysia({ prefix: '/tools', tags: ['Tools'] })
    .use(sessionPlugin)

    /**
     * Dispatch for one person, with no group behind it.
     *
     * Open to anyone, signed in or not: the whole point is that somebody can
     * try the board before registering a group. Nothing is stored — the
     * vehicles live in the browser and these three endpoints only answer
     * questions about a list they are handed.
     */
    .group('/dispatch', (app) =>
        app
            .get('/setup', () => PersonalDispatch.setup(), {
                response: { 200: ToolsModel.dispatchSetup },
                detail: {
                    summary: 'The routes and depots the personal board runs',
                    description:
                        'The built-in routes and depots every new group is seeded with, so what somebody learns here is what they find on the dashboard afterwards.'
                }
            })

            .post('/import', ({ body }) => PersonalDispatch.classify(body), {
                body: ToolsModel.dispatchImportBody,
                response: { 200: ToolsModel.dispatchVehicleList },
                detail: {
                    summary: 'Classify a pasted vehicle list',
                    description:
                        'Works out which list each vehicle belongs in and which depot its spawn name means. The board reconciles the answer against what it already holds.'
                }
            })

            .post(
                '/solve',
                async ({ body, session, request }) => {
                    // Anonymous callers are allowed, so the limit is per
                    // address as well as per account. Solving is cheap, but
                    // this endpoint takes a list of up to 500 vehicles.
                    await rateLimit('tools:solve', session.user?.userId || clientKey(request), 120, 60)

                    return PersonalDispatch.solve(body, session)
                },
                {
                    body: ToolsModel.dispatchSolveBody,
                    response: {
                        200: ToolsModel.dispatchSolveResponse,
                        429: globalModel.rateLimited
                    },
                    detail: {
                        summary: 'Assign routes on a personal board',
                        description:
                            'The same solver the group board uses. Honours the caller\'s own favourite and disliked routes — those are held against the built-in routes by name, so an answer given on a group page applies here too.'
                    }
                }
            )
    )

    .group('/stage', (app) =>
        app
            .get('/', async ({ session }) => StagePrograms.list(session), {
                response: {
                    200: ToolsModel.stageProgramList,
                    401: globalModel.unauthorized
                },
                detail: { summary: 'List your saved stage programs' }
            })

            .post('/', async ({ body, session }) => StagePrograms.create(body, session), {
                body: ToolsModel.createBody,
                response: {
                    200: ToolsModel.createResponse,
                    401: globalModel.unauthorized,
                    409: globalModel.conflict
                },
                detail: { summary: 'Save a stage program' }
            })

            .get('/:id', async ({ params: { id }, session }) => StagePrograms.get(id, session), {
                params: t.Object({ id: t.String({ format: 'uuid' }) }),
                response: {
                    200: ToolsModel.stageProgram,
                    404: globalModel.notFound
                },
                detail: { summary: 'Read a stage program' }
            })

            .patch('/:id', async ({ params: { id }, body, session }) => StagePrograms.update(id, body, session), {
                params: t.Object({ id: t.String({ format: 'uuid' }) }),
                body: ToolsModel.updateBody,
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: globalModel.notFound
                },
                detail: { summary: 'Update a stage program' }
            })

            .delete('/:id', async ({ params: { id }, session }) => StagePrograms.remove(id, session), {
                params: t.Object({ id: t.String({ format: 'uuid' }) }),
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    404: globalModel.notFound
                },
                detail: { summary: 'Delete a stage program' }
            })
    )
