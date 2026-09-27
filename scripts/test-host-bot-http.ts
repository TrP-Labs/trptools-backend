import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import Redis from 'ioredis'
const fixture = JSON.parse(
    await readFile('/tmp/trptools-host-fixture.json', 'utf8'),
)
const redis = new Redis('redis://localhost:56379')
const key = 'room:' + fixture.roomId,
    original = await redis.hgetall(key),
    results: any[] = []
try {
    for (const origin of ['http://localhost:53001', 'http://localhost:53002']) {
        const timeline = JSON.parse(original.timeline!)
        for (const item of timeline)
            if (item.id === 'complete') item.status = 'WAITING'
        await redis.hset(key, {
            timeline: JSON.stringify(timeline),
            expiresAt: String(Date.now() - 300000),
            activeUntil: String(Date.now() + 1500000),
        })
        async function call(path: string, body?: unknown, bot = true) {
            const response = await fetch(origin + path, {
                method: body ? 'POST' : 'GET',
                headers: {
                    ...(bot
                        ? {
                              authorization:
                                  'Bearer local-host-verification-only',
                          }
                        : {
                              cookie: `access_token=${fixture.showcaseToken ?? fixture.token}`,
                          }),
                    'content-type': 'application/json',
                },
                body: body ? JSON.stringify(body) : undefined,
            })
            assert.equal(
                response.status,
                200,
                `${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
            )
            const text = await response.text()
            return text.startsWith('{') || text.startsWith('[')
                ? JSON.parse(text)
                : text
        }
        const current = await call(
            '/bot/internal/guilds/111111111111111111/shift?when=current',
        )
        assert.equal(current.eventId, fixture.eventId)
        assert.equal(current.start, original.occurrence)
        await call(
            '/host/' + fixture.roomId + '/events/complete',
            { operation: 'ACTIVATE' },
            false,
        )
        const actions = await call('/bot/internal/due/lease')
        const action = actions.find(
            (item: any) =>
                item.roomId === fixture.roomId &&
                item.timelineId === 'complete',
        )
        assert.ok(action)
        await call('/bot/internal/due/lease/release', action)
        const retry = (await call('/bot/internal/due/lease')).find(
            (item: any) => item.timelineId === 'complete',
        )
        assert.ok(retry)
        await call('/bot/internal/due/complete', retry)
        const snapshot = await call('/host/' + fixture.roomId, undefined, false)
        assert.equal(
            snapshot.timeline.find((item: any) => item.id === 'complete')
                .status,
            'ACTIVATED',
        )
        assert.equal(
            (
                await call(
                    '/bot/internal/guilds/111111111111111111/shift?when=current',
                )
            ).eventId,
            fixture.eventId,
        )
        assert.equal(await redis.exists(key), 1)
        assert.ok(
            !(await call('/bot/internal/due/lease')).some(
                (item: any) => item.timelineId === 'complete',
            ),
        )
        results.push({
            origin,
            endedShiftStillCurrent: true,
            releaseRetry: true,
            completionStatus: true,
            noDuplicateDelivery: true,
            completionDoesNotCloseRoom: true,
        })
    }
} finally {
    await redis.hset(key, original)
    redis.disconnect()
}
await writeFile(
    '/tmp/trptools-host-bot-http-results.json',
    JSON.stringify(results, null, 2),
)
console.log(JSON.stringify(results))
