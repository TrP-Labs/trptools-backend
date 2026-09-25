/**
 * Boots the bundled API in workerd and probes a real request before a release
 * or deployment may proceed. A Wrangler dry-run proves that the bundle can be
 * produced; this catches failures during module initialization and routing.
 *
 * The health route does not query Postgres or Redis. A tiny local Upstash
 * stand-in catches accidental Redis calls without touching production.
 */

import { fileURLToPath } from 'node:url'

const port = Number(process.env.WORKER_SMOKE_PORT ?? 20_000 + Math.floor(Math.random() * 10_000))
const inspectorPort = port + 10_000
const redisPort = port + 1_000
const origin = `http://127.0.0.1:${port}`
let redisRequests = 0

const redis = Bun.serve({
    hostname: '127.0.0.1',
    port: redisPort,
    fetch: () => {
        redisRequests++
        return Response.json([{ result: [1, 60] }])
    }
})

const worker = Bun.spawn({
    cmd: [
        process.execPath,
        'x',
        'wrangler',
        'dev',
        '--port',
        String(port),
        '--inspector-port',
        String(inspectorPort),
        '--var',
        'DATABASE_URL:postgresql://worker-smoke:worker-smoke@127.0.0.1:9/worker-smoke',
        '--var',
        `UPSTASH_REDIS_REST_URL:http://127.0.0.1:${redisPort}`,
        '--var',
        'UPSTASH_REDIS_REST_TOKEN:worker-smoke',
        '--var',
        'ENCRYPTION_KEY:worker-smoke-only-not-a-production-secret'
    ],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
        ...process.env,
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        WRANGLER_LOG_PATH: '/tmp/trptools-wrangler-smoke.log'
    },
    stdout: 'inherit',
    stderr: 'inherit'
})

let ready = false
let lastError: unknown

try {
    const deadline = Date.now() + 30_000

    while (Date.now() < deadline) {
        if (worker.exitCode !== null) {
            throw new Error(`Wrangler exited before the Worker became ready (exit ${worker.exitCode})`)
        }

        try {
            const response = await fetch(`${origin}/health`)
            const body = await response.text()
            if (!response.ok || body !== '{"status":"ok"}') {
                throw new Error(`unexpected health response: ${response.status} ${body}`)
            }

            ready = true
            console.log(`Worker smoke test passed at ${origin}/health`)
            break
        } catch (error) {
            lastError = error
            await Bun.sleep(250)
        }
    }

    if (!ready) {
        throw new Error(`Worker did not become healthy within 30 seconds: ${String(lastError)}`)
    }

    if (redisRequests !== 0) throw new Error(`health used ${redisRequests} Redis request(s)`)
    console.log('Worker rate-limit binding smoke test passed (no Redis requests)')
} finally {
    worker.kill()
    await worker.exited
    await redis.stop(true)
}
