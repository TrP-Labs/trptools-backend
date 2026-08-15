import { Elysia, t } from 'elysia'
import { ToolsModel } from './model'
import { StagePrograms } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const tools = new Elysia({ prefix: '/tools', tags: ['Tools'] })
    .use(sessionPlugin)

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
