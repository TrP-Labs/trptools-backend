import { neonConfig } from '@neondatabase/serverless'
// A local SQL gateway lets workerd exercise the same Neon transport against
// the isolated Docker Postgres fixture. This entry is never deployed.
neonConfig.fetchEndpoint = 'http://127.0.0.1:54490/sql'
// Exercise the real encryption/VAPID stack while replacing only the provider.
const originalFetch = globalThis.fetch
let sent = 0
globalThis.fetch = ((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('https://fcm.googleapis.com/')) { sent++; return Promise.resolve(new Response(null, { status: 201 })) }
    return originalFetch(input, init)
}) as typeof fetch
const entry = (await import('../src/worker')).default
export default { ...entry, fetch(request: Request, ...args: Parameters<typeof entry.fetch> extends [Request, ...infer Rest] ? Rest : never) {
    if (new URL(request.url).pathname === '/__test/push-count') return Response.json({ sent })
    return entry.fetch(request, ...args)
} }
