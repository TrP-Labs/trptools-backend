import { Redis as IoRedis } from 'ioredis'
import { Redis as UpstashRedis } from '@upstash/redis/cloudflare'
import { env } from './env'
import { resolveUpstashCredentials } from './redisCredentials'
import { redisHash } from './redisHash'

const localOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false
} as const

function upstashCredentials() {
    // Upstash's native Redis URL uses the same host and token as its REST API.
    // Deriving them keeps an existing deployment usable while the explicit
    // REST variables remain the clearer choice for Workers.
    const credentials = resolveUpstashCredentials(
        env.UPSTASH_REDIS_REST_URL,
        env.UPSTASH_REDIS_REST_TOKEN,
        env.REDIS_URL
    )
    if (credentials) return credentials

    throw new Error('Cloudflare Workers require UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN')
}

const localRedis = env.isCloudflareWorker ? null : new IoRedis(env.REDIS_URL, localOptions)
const localSubscriber = localRedis?.duplicate() ?? null
const edgeRedis = env.isCloudflareWorker
    ? new UpstashRedis({ ...upstashCredentials(), automaticDeserialization: false })
    : null

localRedis?.on('error', (error) => console.error('[redis] data connection error:', error.message))
localSubscriber?.on('error', (error) => console.error('[redis] subscriber error:', error.message))

class Pipeline {
    private readonly local = localRedis?.pipeline() ?? null
    private readonly edge = edgeRedis?.pipeline() ?? null

    hgetall(key: string) {
        this.local?.hgetall(key)
        this.edge?.hgetall(key)
        return this
    }

    async exec(): Promise<Array<[Error | null, unknown]> | null> {
        if (this.local) return (await this.local.exec()) as Array<[Error | null, unknown]> | null
        if (!this.edge) return null

        const results = await this.edge.exec({ keepErrors: true })
        // This pipeline only queues HGETALL. With deserialization disabled,
        // Upstash returns [field, value, ...], not the ioredis hash object.
        return results.map(({ result, error }) => [error ? new Error(error) : null, redisHash(result)])
    }
}

/**
 * The subset of Redis used by the API, normalized across ioredis and Upstash's
 * connectionless REST client. Keeping its old call shape makes the edge port
 * local to infrastructure rather than leaking through every service.
 */
export const dataRedis = {
    eval<T>(script: string, keys: string[], args: string[]): Promise<T> {
        return localRedis
            ? localRedis.eval(script, keys.length, ...keys, ...args) as Promise<T>
            : edgeRedis!.eval<string[], T>(script, keys, args)
    },

    get(key: string): Promise<string | null> {
        return localRedis ? localRedis.get(key) : edgeRedis!.get<string>(key)
    },

    set(key: string, value: string, mode?: 'EX', seconds?: number, condition?: 'NX') {
        if (localRedis) {
            if (mode && condition) return localRedis.set(key, value, mode, seconds!, condition)
            if (mode) return localRedis.set(key, value, mode, seconds!)
            return localRedis.set(key, value)
        }
        if (!mode) return edgeRedis!.set(key, value)
        if (condition === 'NX') return edgeRedis!.set(key, value, { ex: seconds!, nx: true })
        return edgeRedis!.set(key, value, { ex: seconds! })
    },

    del(...keys: string[]) {
        return localRedis ? localRedis.del(...keys) : edgeRedis!.del(...keys)
    },

    unlink(...keys: string[]) {
        return localRedis ? localRedis.unlink(...keys) : edgeRedis!.unlink(...keys)
    },

    exists(key: string) {
        return localRedis ? localRedis.exists(key) : edgeRedis!.exists(key)
    },

    expire(key: string, seconds: number) {
        return localRedis ? localRedis.expire(key, seconds) : edgeRedis!.expire(key, seconds)
    },

    incr(key: string) {
        return localRedis ? localRedis.incr(key) : edgeRedis!.incr(key)
    },

    mget(keys: string[]): Promise<Array<string | null>> {
        return localRedis ? localRedis.mget(keys) : edgeRedis!.mget<Array<string | null>>(...keys)
    },

    hget(key: string, field: string): Promise<string | null> {
        return localRedis ? localRedis.hget(key, field) : edgeRedis!.hget<string>(key, field)
    },

    hgetall(key: string): Promise<Record<string, string>> {
        return localRedis
            ? localRedis.hgetall(key)
            : edgeRedis!.hgetall(key).then(redisHash)
    },

    hset(key: string, values: Record<string, string>) {
        return localRedis ? localRedis.hset(key, values) : edgeRedis!.hset(key, values)
    },

    hdel(key: string, ...fields: string[]) {
        return localRedis ? localRedis.hdel(key, ...fields) : edgeRedis!.hdel(key, ...fields)
    },

    hincrby(key: string, field: string, amount: number) {
        return localRedis ? localRedis.hincrby(key, field, amount) : edgeRedis!.hincrby(key, field, amount)
    },

    llen(key: string) {
        return localRedis ? localRedis.llen(key) : edgeRedis!.llen(key)
    },

    lrange(key: string, start: number, stop: number): Promise<string[]> {
        return localRedis ? localRedis.lrange(key, start, stop) : edgeRedis!.lrange<string>(key, start, stop)
    },

    lrem(key: string, count: number, value: string) {
        return localRedis ? localRedis.lrem(key, count, value) : edgeRedis!.lrem(key, count, value)
    },

    rpush(key: string, value: string) {
        return localRedis ? localRedis.rpush(key, value) : edgeRedis!.rpush(key, value)
    },

    publish(channel: string, message: string) {
        return localRedis ? localRedis.publish(channel, message) : edgeRedis!.publish(channel, message)
    },

    pipeline() {
        return new Pipeline()
    }
}

type Listener = (payload: string) => void
const localListeners = new Map<string, Set<Listener>>()

localSubscriber?.on('message', (channel, message) => {
    for (const listener of localListeners.get(channel) ?? []) listener(message)
})

/** One subscription per Worker stream; ioredis keeps sharing one local socket. */
export async function subscribeChannel(channel: string, listener: Listener): Promise<() => void> {
    if (edgeRedis) {
        const subscriber = edgeRedis.subscribe<string>(channel)
        subscriber.on('message', ({ message }) => listener(message))
        subscriber.on('error', (error) => console.error('[redis] subscriber error:', error.message))
        return () => {
            subscriber.removeAllListeners()
            void subscriber.unsubscribe([channel]).catch(() => undefined)
        }
    }

    let bucket = localListeners.get(channel)
    if (!bucket) {
        bucket = new Set()
        localListeners.set(channel, bucket)
        await localSubscriber!.subscribe(channel)
    }
    bucket.add(listener)

    return () => {
        const current = localListeners.get(channel)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            localListeners.delete(channel)
            void localSubscriber!.unsubscribe(channel).catch(() => undefined)
        }
    }
}

/** Deletes matching keys in bounded batches without blocking Redis. */
export async function deleteByPattern(pattern: string) {
    let cursor = '0'
    do {
        const result = localRedis
            ? await localRedis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
            : await edgeRedis!.scan(cursor, { match: pattern, count: 500 })
        cursor = result[0]
        if (result[1].length) await dataRedis.unlink(...result[1])
    } while (cursor !== '0')
}

export const deleteByPrefix = (prefix: string) => deleteByPattern(`${prefix}*`)
