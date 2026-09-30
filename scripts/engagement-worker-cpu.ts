import { readFile, writeFile } from 'node:fs/promises'
const fixture = JSON.parse(
    await readFile('/tmp/trptools-engagement-fixture.json', 'utf8'),
)
if (!process.env.DATABASE_URL?.endsWith('/trptools_engagement_test')) throw new Error('Use isolated test storage')
const push = JSON.parse(await readFile('/tmp/trptools-engagement-push-fixture.json', 'utf8'))
const { default: db, client } = await import('../src/db')
const { notificationDeliveries, events } = await import('../src/db/schema')
const { eq } = await import('drizzle-orm')
const token = fixture.showcaseToken ?? fixture.token
const ws = new WebSocket('ws://localhost:54102/ws')
await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('Inspector unavailable'))
})
let seq = 0
const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: any) => void }
>()
ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data))
    const task = pending.get(msg.id)
    if (task) {
        pending.delete(msg.id)
        msg.error ? task.reject(msg.error) : task.resolve(msg.result)
    }
}
function rpc(method: string, params?: unknown) {
    return new Promise<any>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
    })
}
await rpc('Profiler.enable')
await rpc('Profiler.setSamplingInterval', { interval: 100 })
const origin = 'http://localhost:54002'
type Case = { path: string; method?: string; body?: unknown; trusted?: boolean; setup?: () => Promise<unknown> }
const resetSend = () => db.update(notificationDeliveries).set({ deliveredAt: null, attempts: 0, availableAt: new Date() }).where(eq(notificationDeliveries.id, push.jobId))
const resetPlan = () => db.update(events).set({ notificationAt: new Date() }).where(eq(events.eventId, push.eventId))
const cases: Case[] = [
    { path: '/dashboard/home?mode=user' },
    { path: '/dashboard/home?mode=host' },
    { path: '/statistics/groups/' + fixture.groupId },
    { path: '/notifications/groups/' + fixture.groupId },
    { path: '/users/me/follows/' + fixture.groupId, method: 'PUT', body: { following: true } },
    { path: '/users/me/preferences', method: 'PATCH', body: { instantRedirects: false } },
    { path: '/statistics/events', method: 'POST', body: { events: [{ id: crypto.randomUUID(), groupId: fixture.groupId, kind: 'group_view' }] } },
    { path: '/public/groups/' + fixture.groupSlug + '/join/discord' },
    { path: '/background/notification/plan/' + push.eventId, method: 'POST', trusted: true, setup: resetPlan },
    { path: '/background/notification/send/' + push.jobId, method: 'POST', trusted: true, setup: resetSend },
    { path: '/background/notifications/drain', method: 'POST', trusted: true },
]
const results: any[] = []
for (const entry of cases) {
    const path = entry.path, body = entry.body, method = entry.method ?? 'GET'
    for (let warm = 0; warm < 5; warm++) {
        await entry.setup?.()
        const response = await fetch(origin + path, { method, headers: { cookie: `access_token=${token}`, origin: 'http://localhost:54000', 'content-type': 'application/json', ...(entry.trusted ? { authorization: 'Bearer engagement-local-test-only' } : {}) }, body: body ? JSON.stringify(body) : undefined })
        if (!response.ok) throw new Error(`Warm ${path}: ${response.status} ${await response.text()}`)
        await response.text()
    }
    const samples: number[] = []
    for (let i = 0; i < 10; i++) {
        await entry.setup?.()
        await rpc('Profiler.start')
        const response = await fetch(origin + path, {
            method,
            headers: {
                cookie: `access_token=${token}`,
                origin: 'http://localhost:54000',
                'content-type': 'application/json',
                ...(entry.trusted ? { authorization: 'Bearer engagement-local-test-only' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await response.text()
        const { profile } = await rpc('Profiler.stop')
        const nodes = new Map(profile.nodes.map((node: any) => [node.id, node]))
        let micros = 0
        const functions: Record<string, number> = {}
        for (let j = 0; j < (profile.samples?.length ?? 0); j++) {
            const node = nodes.get(profile.samples[j]) as any
            if (
                node?.callFrame.functionName !== '(idle)' &&
                node?.callFrame.functionName !== '(root)'
            ) {
                micros += profile.timeDeltas[j]
                const name = node?.callFrame.functionName || '(anonymous)'
                functions[name] = (functions[name] ?? 0) + profile.timeDeltas[j]
            }
        }
        samples.push(micros / 1000)
        if (micros > 10000)
            console.log(
                JSON.stringify({
                    path,
                    cpuMs: micros / 1000,
                    functions: Object.entries(functions)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 12),
                }),
            )
    }
    results.push({
        operation: method + ' ' + path.replace(fixture.groupId, ':groupId').replace(fixture.groupSlug, ':slug').replace(push.eventId, ':eventId').replace(push.jobId, ':jobId'),
        samplesMs: samples,
        meanMs: samples.reduce((a, b) => a + b) / samples.length,
        maxMs: Math.max(...samples),
    })
}
ws.close()
await client?.end()
await writeFile(
    '/tmp/trptools-engagement-cpu-results.json',
    JSON.stringify(
        {
            method: 'Local workerd V8 sampling profiler, 100µs interval; warm requests; idle/root samples excluded; estimate, not production CPU billing.',
            results,
        },
        null,
        2,
    ),
)
console.log(JSON.stringify(results))
