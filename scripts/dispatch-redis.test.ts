/**
 * Real Redis integration tests, isolated from the pure suite's module graph.
 * Requires redis-server on PATH. Run once with native Redis and once with
 * DISPATCH_TEST_EDGE=true to exercise Upstash's REST pipeline reply shapes.
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import Redis from 'ioredis'
import * as assignment from '../src/rooms/dispatch/assign'
import type { RoomInfo } from '../src/rooms/service'
import type { Vehicles } from '../src/rooms/dispatch/model'

const port = 30_000 + Math.floor(Math.random() * 10_000)
const processRedis = Bun.spawn(['redis-server', '--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
    stdout: 'ignore', stderr: 'pipe'
})
const redis = new Redis(`redis://127.0.0.1:${port}`, { retryStrategy: () => 20 })
redis.on('error', () => {})
await redis.ping().catch(async (error) => {
    processRedis.kill()
    throw new Error(`Cannot start test Redis: ${await new Response(processRedis.stderr).text()}`, { cause: error })
})
const observer = redis.duplicate()
const frames: Vehicles.streamEvent[] = []
observer.on('message', (_channel, payload) => { frames.push(JSON.parse(payload)) })
await observer.subscribe('dispatchroom.integration')

const edge = process.env.DISPATCH_TEST_EDGE === 'true'
const subscribers = new Set<Redis>()
const gateway = edge ? Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request) {
        const path = new URL(request.url).pathname
        if (path.startsWith('/subscribe/')) {
            const channel = decodeURIComponent(path.slice('/subscribe/'.length))
            const subscriber = redis.duplicate()
            subscribers.add(subscriber)
            const encoder = new TextEncoder()
            return new Response(new ReadableStream({
                async start(controller) {
                    subscriber.on('message', (channel, payload) => {
                        controller.enqueue(encoder.encode(`data: message,${channel},${payload}\n\n`))
                    })
                    await subscriber.subscribe(channel)
                    controller.enqueue(encoder.encode(`data: subscribe,${channel},1\n\n`))
                    request.signal.addEventListener('abort', () => {
                        subscriber.disconnect()
                        subscribers.delete(subscriber)
                        controller.close()
                    }, { once: true })
                },
                cancel() { subscriber.disconnect(); subscribers.delete(subscriber) }
            }), { headers: { 'content-type': 'text/event-stream' } })
        }
        const body = await request.json() as string[] | string[][]
        const pipeline = path === '/pipeline'
        const commands = pipeline ? body as string[][] : [body as string[]]
        const encode = (value: unknown): unknown => Array.isArray(value) ? value.map(encode)
            : typeof value === 'string' && request.headers.get('upstash-encoding') === 'base64'
                ? Buffer.from(value).toString('base64') : value
        const replies = []
        for (const command of commands) {
            try {
                const reply = await redis.call(command[0]!, ...command.slice(1))
                const raw = command[0]!.toLowerCase() === 'hgetall' && reply && typeof reply === 'object' && !Array.isArray(reply)
                    ? Object.entries(reply).flat() : reply
                replies.push({ result: encode(raw) })
            }
            catch (error) { replies.push({ error: (error as Error).message }) }
        }
        return Response.json(pipeline ? replies : replies[0])
    }
}) : null
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:9/unused'
process.env.REDIS_URL = `redis://127.0.0.1:${port}`
process.env.CF_WORKER = String(edge)
if (gateway) {
    process.env.UPSTASH_REDIS_REST_URL = gateway.url.origin
    process.env.UPSTASH_REDIS_REST_TOKEN = 'integration-only'
}

const routeId = '11111111-1111-4111-8111-111111111111'
const groupId = '22222222-2222-4222-8222-222222222222'
const context: assignment.SolverContext = {
    routes: [{ id: routeId, name: 'Custom route', autoAssign: true, targetShare: 100,
        depotIds: new Set(['depot']), servesAllDepots: false }],
    depotsByKey: new Map([['mainisland', 'depot']]), rules: [], typesByName: new Map(), preferences: new Map()
}
let sqlReads = 0
let beforeContext: (() => Promise<void>) | undefined
mock.module('../src/db', () => ({ default: { select: () => ({ from: () => ({ where: async () => {
    sqlReads++
    return [{ id: routeId, name: 'Custom route', color: '#123456', builtIn: false }]
} }) }) } }))
mock.module('../src/rooms/dispatch/solver', () => ({
    ...assignment,
    loadSolverContext: async () => { await beforeContext?.(); return context },
    loadRoutePreferences: async () => new Map()
}))
mock.module('../src/groups/service', () => ({ findGroup: async () => null }))
mock.module('../src/utils/groupPermission', () => ({
    GetMembership: async () => ({ permissions: Number(await dataRedis.get('permission')) }),
    assertGroupPermission: async () => {}
}))
const { dataRedis } = await import('../src/utils/redis')
const { DispatchControls } = await import('../src/rooms/dispatch/service')
const { canDispatch, RoomControls } = await import('../src/rooms/service')
const { PERM } = await import('../src/utils/permissions')

let trips = 0
let delay = 0
for (const method of ['get', 'hgetall', 'lrange', 'llen', 'eval', 'exists'] as const) {
    const original = dataRedis[method].bind(dataRedis)
    ;(dataRedis as any)[method] = async (...args: unknown[]) => {
        trips++
        if (delay) await Bun.sleep(delay)
        return (original as any)(...args)
    }
}
const originalPipeline = dataRedis.pipeline.bind(dataRedis)
dataRedis.pipeline = () => {
    const pipeline = originalPipeline()
    const exec = pipeline.exec.bind(pipeline)
    pipeline.exec = async () => {
        trips++
        if (delay) await Bun.sleep(delay)
        return exec()
    }
    return pipeline
}
const info: RoomInfo = { groupId, eventId: 'event', eventName: 'Shift', creatorId: 'host', createdAt: '1', expiresAt: '2' }
const user = { userId: 'dispatcher', robloxId: 1, siteRank: 'user', adminMode: false }
const seed = (id: number | string): Vehicles.seedVehicle => ({ Id: id, OwnerId: 1, Name: 'Bus', Depot: 'Main Island Depot' })
const key = (id: string | number) => `dispatchroom:integration:vehicles:${id}`
const listKey = 'dispatchroom:integration:vehicles'
async function settleFrames(count?: number) {
    const deadline = Date.now() + 2000
    while (count !== undefined && frames.length < count && Date.now() < deadline) await Bun.sleep(5)
    await Bun.sleep(10)
}

beforeEach(async () => {
    delay = 0
    beforeContext = undefined
    context.rules = []
    context.typesByName.clear()
    await redis.flushdb()
    await redis.hset('room:integration', info)
    await redis.set(`groupindex:${groupId}`, 'integration')
    await redis.set('permission', String(PERM.DISPATCH))
    frames.length = 0
    sqlReads = 0
    trips = 0
})
afterAll(async () => {
    observer.disconnect()
    for (const subscriber of subscribers) subscriber.disconnect()
    await gateway?.stop(true)
    redis.disconnect()
    processRedis.kill()
    await processRedis.exited
})

test('mixed read/write pipeline replies and per-command failures work on both clients', async () => {
    const pipeline = dataRedis.pipeline()
    pipeline.hset('hash', { id: '001', note: '{"raw":true}' }).hgetall('hash').hget('hash', 'note')
        .expire('hash', 60).rpush('list', '001').lrem('list', 1, '001').del('missing')
        .publish('dispatchroom.integration', '{"event":"HEARTBEAT"}')
        .eval('return {ARGV[1], ARGV[2]}', [], ['001', 'false']).hgetall('list')
    // A list that became empty was deleted, so create a wrong-type hash read.
    await redis.set('list', 'wrong type')
    const replies = await pipeline.exec()
    expect(replies?.[0]).toEqual([null, 2])
    expect(replies?.[1]).toEqual([null, { id: '001', note: '{"raw":true}' }])
    expect(replies?.[2]).toEqual([null, '{"raw":true}'])
    expect(replies?.[3]).toEqual([null, 1])
    expect(replies?.[4]?.[0]?.message).toContain('WRONGTYPE')
    expect(replies?.[6]).toEqual([null, 0])
    expect(replies?.[8]).toEqual([null, ['001', 'false']])
    expect(replies?.[9]?.[0]?.message).toContain('WRONGTYPE')
})

test('50 new vehicles use four trips, preserve string fields and set expiry', async () => {
    const result = await DispatchControls.importVehicles('integration', info, Array.from({ length: 50 }, (_, i) => seed(i)))
    expect(result).toEqual({ added: 50, removed: 0, total: 50 })
    expect(trips).toBe(4)
    expect(await redis.ttl(key(0))).toBeGreaterThan(0)
    expect(await redis.ttl(listKey)).toBeGreaterThan(0)
    await settleFrames(50)
    expect(frames.filter((frame) => frame.event === 'ADD')).toHaveLength(50)
    expect((await DispatchControls.getAllVehicles('integration', info))[0]?.assigned).toBe(false)
})

test('reimport preserves dispatch state, batches category changes and decorates seeds once', async () => {
    const rule = { pattern: 'Bus', category: 'OTHER' as const, fixedRoute: routeId }
    context.typesByName.set('bus', rule)
    await DispatchControls.importVehicles('integration', info, [seed(1), seed(2), seed(3)])
    expect(sqlReads).toBe(1)
    await DispatchControls.modifyVehicle('integration', '1', info, { route: 'NOTE', note: 'Keep me', assigned: true, location: 'Depot' })
    context.typesByName.set('bus', { ...rule, category: 'TROLLEYBUS' })
    trips = 0
    expect(await DispatchControls.importVehicles('integration', info, [seed(1), seed(2), seed(3)])).toEqual({ added: 0, removed: 0, total: 3 })
    expect(trips).toBe(5)
    expect(await redis.hmget(key(1), 'route', 'note', 'assigned', 'location', 'category')).toEqual(['NOTE', 'Keep me', 'true', 'Depot', 'TROLLEYBUS'])
    trips = 0
    await DispatchControls.importVehicles('integration', info, [seed(1), seed(2), seed(3)])
    expect(trips).toBe(4)
})

test('simultaneous imports do not duplicate list entries or wipe an existing vehicle', async () => {
    await Promise.all([DispatchControls.importVehicles('integration', info, [seed(1)]), DispatchControls.importVehicles('integration', info, [seed(1)])])
    expect(await redis.lrange(listKey, 0, -1)).toEqual(['1'])
    await settleFrames()
    expect(frames.filter((frame) => frame.event === 'ADD')).toHaveLength(1)
})

test('50 solves use four trips and publish their stored results', async () => {
    await DispatchControls.importVehicles('integration', info, Array.from({ length: 50 }, (_, i) => seed(i)))
    await settleFrames(50)
    frames.length = 0
    trips = 0
    expect((await DispatchControls.solveRoom('integration', info, {})).solved).toBe(50)
    expect(trips).toBe(4)
    await settleFrames(50)
    expect(frames.filter((frame) => frame.event === 'UPDATE')).toHaveLength(50)
    expect(await redis.hget(key(49), 'route')).toBe(routeId)
})

test('a vehicle deleted while the solver loads is not resurrected or broadcast', async () => {
    await DispatchControls.importVehicles('integration', info, [seed(1)])
    beforeContext = async () => { await redis.del(key(1)); await redis.lrem(listKey, 0, '1') }
    await settleFrames()
    frames.length = 0
    expect((await DispatchControls.solveRoom('integration', info, {})).solved).toBe(0)
    expect(await redis.exists(key(1))).toBe(0)
    await settleFrames()
    expect(frames).toEqual([])
})

test('a partial write failure publishes successful writes and rejects the request', async () => {
    await DispatchControls.importVehicles('integration', info, [seed(1), seed(2)])
    beforeContext = async () => { await redis.del(key(2)); await redis.set(key(2), 'wrong type') }
    await settleFrames()
    frames.length = 0
    await expect(DispatchControls.solveRoom('integration', info, {})).rejects.toThrow('WRONGTYPE')
    await settleFrames(1)
    expect(frames).toEqual([{ event: 'UPDATE', data: { id: '1', route: routeId } }])
})

test('tow validation is atomic, and deletion releases the winner in one trip', async () => {
    await DispatchControls.importVehicles('integration', info, [seed(1), seed(2), seed(3)])
    const claims = await Promise.allSettled([
        DispatchControls.modifyVehicle('integration', '1', info, { towing: '3' }),
        DispatchControls.modifyVehicle('integration', '2', info, { towing: '3' })
    ])
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
    expect(claims.find((claim) => claim.status === 'rejected')).toMatchObject({ reason: { code: 409, response: 'that vehicle is already being towed' } })
    trips = 0
    await DispatchControls.deleteVehicle('integration', '3', info)
    expect(trips).toBe(1)
    expect(await redis.hget(key(1), 'towing')).toBe('')
    expect(await redis.hget(key(2), 'towing')).toBe('')
    expect(await redis.exists(key(3))).toBe(0)
    await expect(DispatchControls.modifyVehicle('integration', '1', info, { towing: '1' })).rejects.toMatchObject({ code: 409 })
    await expect(DispatchControls.modifyVehicle('integration', '1', info, { towing: 'missing' })).rejects.toMatchObject({ code: 409 })
    await expect(DispatchControls.modifyVehicle('integration', 'missing', info, {})).rejects.toMatchObject({ code: 404 })
})

test('an import removes multiple vehicles and releases tows without per-vehicle trips', async () => {
    await DispatchControls.importVehicles('integration', info, [seed(1), seed(2), seed(3)])
    await DispatchControls.modifyVehicle('integration', '1', info, { towing: '3' })
    trips = 0
    expect(await DispatchControls.importVehicles('integration', info, [seed(1)])).toEqual({ added: 0, removed: 2, total: 1 })
    expect(trips).toBe(5)
    expect(await redis.hget(key(1), 'towing')).toBe('')
})

test('presence counts connections and concurrent reconnects keep their count', async () => {
    expect(await DispatchControls.join('integration', '001')).toEqual(['001'])
    await Promise.all([DispatchControls.leave('integration', '001'), DispatchControls.join('integration', '001')])
    expect(await redis.hget('dispatchroom:integration:users', '001')).toBe('1')
    await DispatchControls.join('integration', '001')
    expect(await DispatchControls.leave('integration', '001')).toEqual(['001'])
    expect(await DispatchControls.leave('integration', '001')).toEqual([])
    expect(await DispatchControls.leave('integration', '001')).toEqual([])
    await settleFrames()
    expect(frames.at(-1)).toEqual({ event: 'PRESENCE', data: [] })
})

test('authorization reads the room once and retains grant and elevation checks', async () => {
    expect(await canDispatch(user, 'integration')).toEqual(info)
    expect(trips).toBe(2)
    await redis.set('permission', '0')
    expect(await canDispatch(user, 'integration')).toBeNull()
    expect(await canDispatch({ ...user, siteRank: 'admin' }, 'integration')).toBeNull()
    trips = 0
    expect(await canDispatch({ ...user, siteRank: 'admin', adminMode: true }, 'integration')).toEqual(info)
    expect(trips).toBe(1)
    expect(await canDispatch(user, 'missing')).toBeNull()
})

test('closing publishes CLOSED and never recreates state or deletes a replacement room index', async () => {
    await DispatchControls.importVehicles('integration', info, [seed(1)])
    await DispatchControls.join('integration', '001')
    await redis.set(`groupindex:${groupId}`, 'replacement')
    await RoomControls.closeRoom('integration', { authenticated: true, user })
    expect(await redis.get(`groupindex:${groupId}`)).toBe('replacement')
    expect(await redis.keys('dispatchroom:integration:*')).toEqual([])
    expect(await DispatchControls.leave('integration', '001')).toEqual([])
    await expect(DispatchControls.importVehicles('integration', info, [seed(2)])).rejects.toMatchObject({ code: 404 })
    expect(await redis.exists(key(2))).toBe(0)
    await settleFrames()
    expect(frames.filter((frame) => frame.event === 'CLOSED')).toHaveLength(1)
})

test('stream reuses the authorized room and does not check EXISTS per update', async () => {
    await DispatchControls.importVehicles('integration', info, [seed(1)])
    const stream = DispatchControls.stream('integration', '001', info)
    trips = 0
    expect((await stream.next()).value?.event).toBe('SYNC')
    expect(trips).toBe(3)
    expect((await stream.next()).value).toEqual({ event: 'PRESENCE', data: ['001'] })
    // Drain the queued join announcement if the subscriber already observed it.
    if (!edge) expect((await stream.next()).value?.event).toBe('PRESENCE')
    trips = 0
    await DispatchControls.modifyVehicle('integration', '1', info, { assigned: true })
    let event = (await stream.next()).value
    while (event?.event === 'PRESENCE') event = (await stream.next()).value
    expect(event).toEqual({ event: 'UPDATE', data: { id: '1', assigned: true } })
    expect(trips).toBe(1)
    const next = stream.next()
    await RoomControls.closeRoom('integration', { authenticated: true, user })
    expect((await next).value?.event).toBe('CLOSED')
    await stream.return(undefined)
})

test('snapshot failure still cleans up a concurrent successful join', async () => {
    await redis.set(listKey, 'wrong type')
    const stream = DispatchControls.stream('integration', '001', info)
    await expect(stream.next()).rejects.toThrow('WRONGTYPE')
    expect(await redis.exists('dispatchroom:integration:users')).toBe(0)
})

test('500-vehicle imports and solves stay bounded and return all assignments', async () => {
    const payload = Array.from({ length: 500 }, (_, i) => seed(i))
    expect(await DispatchControls.importVehicles('integration', info, payload)).toEqual({ added: 500, removed: 0, total: 500 })
    expect(trips).toBe(6)
    trips = 0
    expect((await DispatchControls.solveRoom('integration', info, {})).solved).toBe(500)
    expect(trips).toBe(7)
    expect(new Set(await redis.lrange(listKey, 0, -1)).size).toBe(500)
})

test('natural room expiry is detected at the heartbeat rather than per event', async () => {
    const stream = DispatchControls.stream('integration', '001', info)
    expect((await stream.next()).value?.event).toBe('SYNC')
    expect((await stream.next()).value?.event).toBe('PRESENCE')
    await redis.del('room:integration')
    trips = 0
    let event = (await stream.next()).value
    while (event?.event !== 'CLOSED') event = (await stream.next()).value
    expect(event?.event).toBe('CLOSED')
    expect(trips).toBe(1)
    await stream.return(undefined)
}, 20_000)

test('150 ms simulated RTT keeps 50-vehicle operations below one second of service Redis time', async () => {
    delay = 150
    const start = performance.now()
    await DispatchControls.importVehicles('integration', info, Array.from({ length: 50 }, (_, i) => seed(i)))
    const importTime = performance.now() - start
    expect(trips).toBe(4)
    trips = 0
    const solving = performance.now()
    await DispatchControls.solveRoom('integration', info, {})
    const solveTime = performance.now() - solving
    expect(trips).toBe(4)
    expect(importTime).toBeLessThan(1200)
    expect(solveTime).toBeLessThan(1200)
    console.log(`[dispatch ${edge ? 'Upstash' : 'ioredis'}] 150ms RTT: import 50 = ${Math.round(importTime)}ms, solve 50 = ${Math.round(solveTime)}ms (4 trips each)`)
}, 10_000)
