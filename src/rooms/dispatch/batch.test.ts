import { expect, test } from 'bun:test'
import { assertResults, runBatches, type RedisTask } from './batch'

test('bounds large pipelines and preserves reply order', async () => {
    const sizes: number[] = []
    let next = 0
    const redis = { pipeline: () => {
        const replies: Array<[null, number]> = []
        return {
            hgetall: () => { replies.push([null, next++]) },
            exec: async () => { sizes.push(replies.length); return replies }
        } as unknown as ReturnType<Parameters<typeof runBatches>[0]['pipeline']>
    } }
    const tasks: RedisTask[] = Array.from({ length: 600 }, () => (pipeline) => { pipeline.hgetall('vehicle') })
    const results = await runBatches(redis, tasks)
    expect(sizes).toEqual([256, 256, 88])
    expect(results.map(([, value]) => value)).toEqual(Array.from({ length: 600 }, (_, i) => i))
    expect(await runBatches(redis, [])).toEqual([])
    expect(sizes).toHaveLength(3)
})

test('rejects missing replies and surfaces individual Redis errors', async () => {
    const redis = { pipeline: () => ({ exec: async () => null }) as unknown as ReturnType<Parameters<typeof runBatches>[0]['pipeline']> }
    await expect(runBatches(redis, [() => {}])).rejects.toThrow('Incomplete Redis pipeline response')
    expect(() => assertResults([[null, 1], [new Error('WRONGTYPE'), null]])).toThrow('WRONGTYPE')
})
