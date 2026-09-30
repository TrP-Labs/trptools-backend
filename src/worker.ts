import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import { registerRequestLifetime } from './utils/requestLifetime'
import { authorizedBackgroundJob } from './background/auth'
import { app } from './index'
import { env } from './utils/env'
import {
    checkWorkerRateLimit,
    type WorkerRateLimitBindings,
} from './utils/workerRateLimit'

/**
 * Cloudflare needs a Fetch entry point instead of Bun's listening socket.
 * Keeping this as a thin wrapper leaves the route tree — and therefore the
 * Eden type exported from index.ts — identical in both deployments.
 */
const workerApp = new Elysia({ adapter: CloudflareAdapter }).use(app).compile()

export default {
    async scheduled(_controller: unknown, _bindings: unknown, context: { waitUntil(promise: Promise<unknown>): void }) {
        const { aggregateStatistics } = await import('./statistics/collector')
        context.waitUntil(aggregateStatistics())
        if (!env.BACKGROUND_JOB_TOKEN) return
        const { runNotificationTick } = await import('./notifications/scheduler')
        context.waitUntil(runNotificationTick(async (kind, id) => {
            const response = await fetch(`${env.BASE_URL}/background/notification/${kind}/${id}`, {
                method: 'POST', headers: { authorization: `Bearer ${env.BACKGROUND_JOB_TOKEN}` }, signal: AbortSignal.timeout(20_000)
            })
            if (!response.ok) throw new Error(`Background notification ${kind}: ${response.status}`)
        }))
    },
    async fetch(
        request: Request,
        bindings: WorkerRateLimitBindings,
        context?: { waitUntil(promise: Promise<unknown>): void },
    ) {
        if (context) registerRequestLifetime(request, context)
        const limited = authorizedBackgroundJob(request) ? null : await checkWorkerRateLimit(
            request,
            bindings,
            env.BOT_SERVICE_TOKEN,
        )
        return limited ?? workerApp.fetch(request)
    },
}
