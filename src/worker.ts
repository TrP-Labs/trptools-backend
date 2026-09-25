import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import { app } from './index'
import { checkWorkerRateLimit, type WorkerRateLimitBindings } from './utils/workerRateLimit'

/**
 * Cloudflare needs a Fetch entry point instead of Bun's listening socket.
 * Keeping this as a thin wrapper leaves the route tree — and therefore the
 * Eden type exported from index.ts — identical in both deployments.
 */
const workerApp = new Elysia({ adapter: CloudflareAdapter }).use(app).compile()

export default {
    async fetch(request: Request, bindings: WorkerRateLimitBindings) {
        const limited = await checkWorkerRateLimit(request, bindings)
        return limited ?? workerApp.fetch(request)
    }
}
