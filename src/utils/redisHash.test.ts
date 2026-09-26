import { expect, test } from 'bun:test'
import { redisHash } from './redisHash'

test('decodes Upstash HGETALL pairs without deserializing stored strings', () => {
    expect(redisHash(['id', '1051', 'assigned', 'false', 'note', '{"raw":true}'])).toEqual({
        id: '1051', assigned: 'false', note: '{"raw":true}'
    })
    expect(redisHash([])).toEqual({})
})

test('mixed pipeline replies retain scalar and script values', async () => {
    const { pipelineResult } = await import('./redisHash')
    expect(pipelineResult(['id', '1051'], undefined, true)).toEqual([null, { id: '1051' }])
    expect(pipelineResult(1, undefined, false)).toEqual([null, 1])
    expect(pipelineResult(['001', 'false'], undefined, false)).toEqual([null, ['001', 'false']])
    expect(pipelineResult(null, 'WRONGTYPE', false)[0]?.message).toBe('WRONGTYPE')
})
