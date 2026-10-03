import { neonConfig } from '@neondatabase/serverless'

// Test entry only: exercise the deployed Worker with local Neon, Upstash and
// Roblox stand-ins. No provider request may leave this fixture.
neonConfig.fetchEndpoint = 'http://127.0.0.1:54133/sql'
const originalFetch = globalThis.fetch
globalThis.fetch = (function (this: unknown, input, init) {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'apis.roblox.com') {
        // Preserve the receiver so the fixture also catches Workers' illegal-invocation errors.
        return originalFetch.call(this, new Request(`http://127.0.0.1:54133/roblox?target=${encodeURIComponent(request.url)}`, request))
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External provider disabled in Worker fixture')
    return originalFetch.call(this, request)
}) as typeof fetch
export default (await import('../src/worker')).default
