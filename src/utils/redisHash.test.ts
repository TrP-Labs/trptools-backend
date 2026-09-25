import { expect, test } from 'bun:test'
import { redisHash } from './redisHash'

test('decodes Upstash HGETALL pairs without deserializing stored strings', () => {
    expect(redisHash(['id', '1051', 'assigned', 'false', 'note', '{"raw":true}'])).toEqual({
        id: '1051', assigned: 'false', note: '{"raw":true}'
    })
    expect(redisHash([])).toEqual({})
})
