import { readFile, writeFile } from 'node:fs/promises'
const fixture = JSON.parse(
    await readFile('/tmp/trptools-host-fixture.json', 'utf8'),
)
const token = fixture.showcaseToken ?? fixture.token
const ws = new WebSocket('ws://localhost:53102/ws')
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
const origin = 'http://localhost:53002'
const paths = [
    '/host/' + fixture.roomId,
    '/host/' + fixture.roomId + '/extend',
    '/host/' + fixture.roomId + '/note',
]
const results: any[] = []
for (const path of paths) {
    const body = path.endsWith('/extend')
        ? { minutes: 5 }
        : path.endsWith('/note')
          ? { note: 'Main Island services are open.', ownerRobloxId: '123456' }
          : undefined
    const method = path.endsWith('/extend') ? 'POST' : body ? 'PUT' : 'GET'
    // Warm module initialization, schema compilation and caches separately.
    for (let warm = 0; warm < 5; warm++) {
        await fetch(origin + path, {
            method,
            headers: {
                cookie: `access_token=${token}`,
                'content-type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        })
    }
    const samples: number[] = []
    for (let i = 0; i < 10; i++) {
        await rpc('Profiler.start')
        const response = await fetch(origin + path, {
            method,
            headers: {
                cookie: `access_token=${token}`,
                'content-type': 'application/json',
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
        operation: method + ' ' + path.replace(fixture.roomId, ':roomId'),
        samplesMs: samples,
        meanMs: samples.reduce((a, b) => a + b) / samples.length,
        maxMs: Math.max(...samples),
    })
}
ws.close()
await writeFile(
    '/tmp/trptools-host-cpu-results.json',
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
