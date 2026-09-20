import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import { app } from './index'

/**
 * Cloudflare needs a Fetch entry point instead of Bun's listening socket.
 * Keeping this as a thin wrapper leaves the route tree — and therefore the
 * Eden type exported from index.ts — identical in both deployments.
 */
export default new Elysia({ adapter: CloudflareAdapter }).use(app).compile()
