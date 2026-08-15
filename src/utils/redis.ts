import { Redis } from 'ioredis'
import { env } from './env'

const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false
} as const

/** Primary connection used for reads and writes. */
export const dataRedis = new Redis(env.REDIS_URL, options)

/**
 * ioredis puts a connection into subscriber mode permanently, so pub/sub needs
 * its own sockets. `publisher` shares the data connection; `subscriber` is
 * dedicated.
 */
export const subscriberRedis = dataRedis.duplicate()

dataRedis.on('error', (error) => console.error('[redis] data connection error:', error.message))
subscriberRedis.on('error', (error) => console.error('[redis] subscriber error:', error.message))

/** Deletes every key matching a prefix without blocking the server. */
export async function deleteByPrefix(prefix: string) {
    const stream = dataRedis.scanStream({ match: `${prefix}*`, count: 500 })
    for await (const keys of stream) {
        if (keys.length) await dataRedis.unlink(...keys)
    }
}
