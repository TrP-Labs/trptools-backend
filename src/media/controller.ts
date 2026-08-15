import { Elysia, t } from 'elysia'
import { MediaModel } from './model'
import { MediaService } from './service'
import { globalModel } from '../utils/globalModel'
import { requireUser, sessionPlugin } from '../utils/authPlugin'
import { rateLimit } from '../utils/ratelimit'

export const mediaRoutes = new Elysia({ prefix: '/media', tags: ['Media'] })
    .use(sessionPlugin)

    .get('/', async ({ query, session }) => MediaService.list(query, session), {
        query: MediaModel.listQuery,
        response: {
            200: MediaModel.list,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'List a group\'s uploaded images' }
    })

    .post(
        '/',
        async ({ body, session }) => {
            const user = requireUser(session)
            // Uploads cost storage and bandwidth, so they are metered per account.
            await rateLimit('media:upload', user.userId, 30, 300)

            return MediaService.upload(body, session)
        },
        {
            body: MediaModel.uploadBody,
            type: 'multipart/form-data',
            response: {
                200: MediaModel.item,
                400: MediaModel.notAnImage,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: globalModel.notFound,
                409: globalModel.conflict,
                413: MediaModel.notAnImage,
                503: MediaModel.storageUnavailable
            },
            detail: {
                summary: 'Upload an image',
                description:
                    'Accepts PNG, JPEG, WebP and GIF up to 6MB. The file is verified by its magic number, not the declared content type.'
            }
        }
    )

    .put(
        '/icon',
        async ({ body, session }) => {
            const user = requireUser(session)
            await rateLimit('media:upload', user.userId, 30, 300)

            return MediaService.setIcon(body, session)
        },
        {
            body: MediaModel.iconBody,
            type: 'multipart/form-data',
            response: {
                200: MediaModel.iconResponse,
                400: t.Union([MediaModel.notAnImage, globalModel.badRequest]),
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: globalModel.notFound,
                413: MediaModel.notAnImage,
                503: MediaModel.storageUnavailable
            },
            detail: {
                summary: 'Set a route badge, depot icon or group banner',
                description:
                    'Uploads the image and points the owner at it in one call, then deletes whatever it replaced.'
            }
        }
    )

    .delete('/icon', async ({ query, session }) => MediaService.clearIcon(query, session), {
        query: MediaModel.iconTarget,
        response: {
            200: MediaModel.iconResponse,
            400: globalModel.badRequest,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Remove a badge, icon or banner' }
    })

    .patch('/:id', async ({ params: { id }, body, session }) => MediaService.update(id, body, session), {
        params: t.Object({ id: t.String({ format: 'uuid' }) }),
        body: MediaModel.patchBody,
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Update a caption or ordering' }
    })

    .delete('/:id', async ({ params: { id }, session }) => MediaService.remove(id, session), {
        params: t.Object({ id: t.String({ format: 'uuid' }) }),
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Delete an image' }
    })
