import postgres from 'postgres'
import Redis from 'ioredis'

export async function startClaimableWorker(realFetch: typeof fetch, providerFetch: typeof fetch) {
    const sql = postgres(process.env.DATABASE_URL!, { prepare: false, types: { raw: {
        to: 0, from: [16, 20, 21, 23, 700, 701, 1082, 1114, 1184, 114, 3802, 1700],
        serialize: value => String(value), parse: value => value
    } } })
    const redis = new Redis(process.env.REDIS_URL!)
    const bridge = Bun.serve({ hostname: '127.0.0.1', port: 54133, async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/roblox') return providerFetch(new Request(url.searchParams.get('target')!, request))
        if (url.pathname === '/sql') {
            const body = await request.json() as { query: string; params: string[] }
            try {
                const rows = await sql.unsafe(body.query, body.params).values()
                return Response.json({ fields: rows.columns.map(column => ({ name: column.name, dataTypeID: column.type })),
                    rows, command: rows.command, rowCount: rows.count })
            } catch { return Response.json({ message: 'Local SQL fixture failed' }, { status: 400 }) }
        }
        const body = await request.json() as string[] | string[][]
        const commands = url.pathname === '/pipeline' ? body as string[][] : [body as string[]]
        const encode = (value: unknown): unknown => Array.isArray(value) ? value.map(encode)
            : typeof value === 'string' && request.headers.get('upstash-encoding') === 'base64' ? Buffer.from(value).toString('base64') : value
        const replies = []
        for (const command of commands) {
            try { replies.push({ result: encode(await redis.call(command[0]!, ...command.slice(1))) }) }
            catch (error) { replies.push({ error: (error as Error).message }) }
        }
        return Response.json(url.pathname === '/pipeline' ? replies : replies[0])
    } })
    const vars = { DATABASE_URL: process.env.DATABASE_URL!, UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:54133',
        UPSTASH_REDIS_REST_TOKEN: 'claimable-test', ENCRYPTION_KEY: 'claimable-test-key',
        BASE_URL: 'http://localhost:54101', FRONTEND_URL: 'http://localhost:54100',
        ROBLOX_CLIENT_ID: 'claimable-test', ROBLOX_CLIENT_SECRET: 'claimable-test',
        SITE_ADMINS: '', DISCORD_APP_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_BOT_TOKEN: '',
        VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', UPSTASH_DISABLE_TELEMETRY: 'true' }
    const worker = Bun.spawn({ cmd: [process.execPath, 'x', 'wrangler', 'dev', 'scripts/claimables-worker-entry.ts',
        '--port', '54134', '--inspector-port', '54135', ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`])],
        env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_LOG_PATH: '/tmp/trptools-claimable-worker.log' },
        stdout: 'inherit', stderr: 'inherit' })
    async function stop() { worker.kill(); await worker.exited; await bridge.stop(true); redis.disconnect(); await sql.end() }
    try {
        const deadline = Date.now() + 30_000
        while (true) {
            if (worker.exitCode !== null || Date.now() > deadline) throw new Error('Claimable Worker did not start')
            try { if ((await realFetch('http://127.0.0.1:54134/health')).ok) break } catch { /* Startup. */ }
            await Bun.sleep(250)
        }
    } catch (error) { await stop(); throw error }
    return { stop, handle(request: Request) {
        const url = new URL(request.url)
        return realFetch(new Request(`http://127.0.0.1:54134${url.pathname}${url.search}`, request), { redirect: 'manual' })
    } }
}
