import { Elysia, status, t } from 'elysia'
import { authorizedBackgroundJob } from './auth'
export const background = new Elysia({ prefix: '/background' })
    .onBeforeHandle(({ request }) => { if (!authorizedBackgroundJob(request)) throw status(401, 'Unauthorized') })
    .post('/notification/:kind/:id', async ({ params }) => {
        if (params.kind === 'plan') {
            const { planNotification } = await import('../notifications/scheduler')
            await planNotification(params.id)
        } else {
            const { deliverNotification } = await import('../notifications/delivery')
            await deliverNotification(params.id)
        }
        return 'Success' as const
    }, { params: t.Object({ kind: t.Union([t.Literal('plan'), t.Literal('send')]), id: t.String({ format: 'uuid' }) }), detail: { hide: true } })
