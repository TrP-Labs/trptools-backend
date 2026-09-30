import { Elysia, t } from 'elysia'
import { sessionPlugin } from '../utils/authPlugin'
import { globalModel } from '../utils/globalModel'
import { NotificationModel } from './model'
import { Notifications } from './service'
const groupParams = t.Object({ groupId: t.String({ format: 'uuid' }) })
const responses = { 200: globalModel.genericSuccess, 400: globalModel.badRequest, 401: globalModel.unauthorized,
    404: globalModel.notFound, 409: t.Literal('Conflict'), 503: t.Literal('Service Unavailable') }
export const notifications = new Elysia({ prefix: '/notifications', tags: ['Users'] })
    .use(sessionPlugin)
    .get('/groups/:groupId', ({ params, query, session }) => Notifications.state(params.groupId, query.eventId, session), {
        params: groupParams, query: t.Object({ eventId: t.Optional(t.String({ format: 'uuid' })) }),
        response: { 200: NotificationModel.state, 401: globalModel.unauthorized }
    })
    .put('/groups/:groupId', ({ params, body, session }) => Notifications.watch(params.groupId, body, session), {
        params: groupParams, body: NotificationModel.watchBody, response: responses
    })
    .put('/subscription', ({ body, session }) => Notifications.subscribe(body, session), {
        body: NotificationModel.subscription, response: responses
    })
    .delete('/subscription', ({ body, session }) => Notifications.unsubscribe(body.endpoint, session), {
        body: t.Object({ endpoint: t.String({ maxLength: 2048 }) }), response: responses
    })
