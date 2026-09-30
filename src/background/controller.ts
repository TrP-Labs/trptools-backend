import { Elysia, status, t } from 'elysia'
import { env } from '../utils/env'
import { finishRequestCleanup } from '../utils/requestLifetime'
import { authorizedBackgroundJob } from './auth'
export const background = new Elysia({ prefix: '/background' })
    .onBeforeHandle(({ request }) => { if (!authorizedBackgroundJob(request)) throw status(401, 'Unauthorized') })
    .post('/notifications/drain', async ({ query, request }) => {
        const { drainNotificationBatch } = await import('../notifications/scheduler')
        const more = await drainNotificationBatch(async (_kind, id) => {
            const response = await fetch(`${env.BASE_URL}/background/notification/send/${id}`, {
                method: 'POST', headers: { authorization: `Bearer ${env.BACKGROUND_JOB_TOKEN}` }, signal: AbortSignal.timeout(20_000)
            })
            if (!response.ok) throw new Error(`Notification send: ${response.status}`)
        })
        const hop = Number(query.hop ?? 0)
        if (more && hop < 14) {
            const next = fetch(`${env.BASE_URL}/background/notifications/drain?hop=${hop + 1}`, {
                method: 'POST', headers: { authorization: `Bearer ${env.BACKGROUND_JOB_TOKEN}` }, signal: AbortSignal.timeout(120_000)
            }).then(response => { if (!response.ok) throw new Error(`Notification drain: ${response.status}`) })
                .catch(error => console.error('[notifications] drain deferred to next tick', error instanceof Error ? error.message : 'unknown'))
            finishRequestCleanup(request, next)
        }
        return 'Success' as const
    }, { query: t.Object({ hop: t.Optional(t.String({ pattern: '^(?:[0-9]|1[0-4])$' })) }), detail: { hide: true } })
    .post('/notification/:kind/:id' , async ({ params }) => {
        if (params.kind === 'plan') {
            const { planNotification } = await import('../notifications/scheduler')
            await planNotification(params.id)
        } else {
            const { deliverNotification } = await import('../notifications/delivery')
            await deliverNotification(params.id)
        }
        return 'Success' as const
    }, { params: t.Object({ kind: t.Union([t.Literal('plan'), t.Literal('send')]), id: t.String({ format: 'uuid' }) }), detail: { hide: true } })
