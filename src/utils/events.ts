import { dataRedis, subscribeChannel } from './redis'

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
    subscribe(channel: string, listener: (payload: string) => void): Promise<() => void> {
        return subscribeChannel(channel, (payload) => {
            try {
                listener(payload)
            } catch {
                // A misbehaving stream must not take down its neighbours.
            }
        })
    }
}
