import { dataRedis, subscriberRedis } from './redis'

type Listener = (payload: string) => void

const listeners = new Map<string, Set<Listener>>()

subscriberRedis.on('message', (channel, message) => {
    const bucket = listeners.get(channel)
    if (!bucket) return
    for (const listener of bucket) {
        try {
            listener(message)
        } catch {
            // A misbehaving stream must not take down its neighbours.
        }
    }
})

/**
 * Fan-out for realtime dispatch updates.
 *
 * The prototype used NATS for this. Redis pub/sub covers the same ground with
 * one fewer moving part, which matters because the deployment target is a
 * single docker-compose file or an edge runtime.
 */
export const broker = {
    publish(channel: string, payload: unknown) {
        return dataRedis.publish(channel, JSON.stringify(payload)).catch(() => 0)
    },

    /** Subscribes to a channel. Returns an unsubscribe function. */
    async subscribe(channel: string, listener: Listener): Promise<() => void> {
        let bucket = listeners.get(channel)

        if (!bucket) {
            bucket = new Set()
            listeners.set(channel, bucket)
            await subscriberRedis.subscribe(channel).catch(() => undefined)
        }

        bucket.add(listener)

        return () => {
            const current = listeners.get(channel)
            if (!current) return
            current.delete(listener)
            if (current.size === 0) {
                listeners.delete(channel)
                void subscriberRedis.unsubscribe(channel).catch(() => undefined)
            }
        }
    }
}
