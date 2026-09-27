import postgres from 'postgres'
import Redis from 'ioredis'
const sql = postgres(
    'postgresql://trptools:trptools@localhost:55432/trptools',
    {
        prepare: false,
        types: {
            raw: {
                to: 0,
                from: [
                    16, 20, 21, 23, 700, 701, 1082, 1114, 1184, 114, 3802, 1700,
                ],
                serialize: (value) => String(value),
                parse: (value) => value,
            },
        },
    },
)
const redis = new Redis('redis://localhost:56379')
const subscribers = new Set<Redis>()
Bun.serve({
    hostname: '127.0.0.1',
    port: 56490,
    idleTimeout: 0,
    async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/sql') {
            const body = (await request.json()) as {
                query: string
                params: unknown[]
            }
            try {
                const rows = await sql
                    .unsafe(body.query, body.params as any[])
                    .values()
                return Response.json({
                    fields: rows.columns.map((column) => ({
                        name: column.name,
                        dataTypeID: column.type,
                    })),
                    rows,
                    command: rows.command,
                    rowCount: rows.count,
                })
            } catch (error) {
                console.error(error)
                return Response.json(
                    { message: 'Local SQL fixture failed' },
                    { status: 400 },
                )
            }
        }
        if (path.startsWith('/subscribe/')) {
            const channel = decodeURIComponent(
                    path.slice('/subscribe/'.length),
                ),
                subscriber = redis.duplicate()
            subscribers.add(subscriber)
            const encoder = new TextEncoder()
            return new Response(
                new ReadableStream({
                    async start(controller) {
                        subscriber.on('message', (channel, payload) =>
                            controller.enqueue(
                                encoder.encode(
                                    `data: message,${channel},${payload}\n\n`,
                                ),
                            ),
                        )
                        await subscriber.subscribe(channel)
                        controller.enqueue(
                            encoder.encode(`data: subscribe,${channel},1\n\n`),
                        )
                        request.signal.addEventListener(
                            'abort',
                            () => {
                                subscriber.disconnect()
                                subscribers.delete(subscriber)
                            },
                            { once: true },
                        )
                    },
                    cancel() {
                        subscriber.disconnect()
                        subscribers.delete(subscriber)
                    },
                }),
                { headers: { 'content-type': 'text/event-stream' } },
            )
        }
        const body = (await request.json()) as string[] | string[][]
        const pipeline = path === '/pipeline'
        const commands = pipeline ? (body as string[][]) : [body as string[]]
        const encode = (value: unknown): unknown =>
            Array.isArray(value)
                ? value.map(encode)
                : typeof value === 'string' &&
                    request.headers.get('upstash-encoding') === 'base64'
                  ? Buffer.from(value).toString('base64')
                  : value
        const replies = []
        for (const command of commands) {
            try {
                let result = await redis.call(command[0]!, ...command.slice(1))
                if (
                    command[0]!.toLowerCase() === 'hgetall' &&
                    result &&
                    !Array.isArray(result)
                )
                    result = Object.entries(
                        result as Record<string, string>,
                    ).flat()
                replies.push({ result: encode(result) })
            } catch (error) {
                replies.push({ error: (error as Error).message })
            }
        }
        return Response.json(pipeline ? replies : replies[0])
    },
})
console.log('Local Neon / Upstash bridge on :56490')
