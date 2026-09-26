import type { dataRedis } from '../../utils/redis'

type Pipeline = ReturnType<typeof dataRedis.pipeline>
type Redis = Pick<typeof dataRedis, 'pipeline'>
export type RedisResult = [Error | null, unknown]
export type RedisTask = (pipeline: Pipeline) => void
const BATCH_SIZE = 256

/** Bound reply memory and REST payload sizes, including for old oversized rooms. */
export async function runBatches(redis: Redis, tasks: RedisTask[]): Promise<RedisResult[]> {
    const results: RedisResult[] = []
    for (let start = 0; start < tasks.length; start += BATCH_SIZE) {
        const batch = tasks.slice(start, start + BATCH_SIZE)
        const pipeline = redis.pipeline()
        for (const task of batch) task(pipeline)
        const replies = await pipeline.exec()
        if (!replies || replies.length !== batch.length) throw new Error('Incomplete Redis pipeline response')
        results.push(...replies)
    }
    return results
}

export function assertResults(results: RedisResult[]) {
    const failed = results.find(([error]) => error !== null)
    if (failed) throw failed[0]
}
