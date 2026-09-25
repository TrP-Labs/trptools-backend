import { expect, test } from 'bun:test'
import { checkWorkerRateLimit, type WorkerRateLimit } from './workerRateLimit'

function limiter(success: boolean, keys: string[]): WorkerRateLimit {
    return { async limit({ key }) { keys.push(key); return { success } } }
}

test('ordinary Worker requests use the global native limit and trusted IP', async () => {
    const globalKeys: string[] = []
    const botKeys: string[] = []
    const request = new Request('https://apis.trptools.com/health', {
        headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.2' }
    })
    const result = await checkWorkerRateLimit(request, {
        GLOBAL_RATE_LIMIT: limiter(true, globalKeys),
        BOT_RATE_LIMIT: limiter(false, botKeys)
    }, 'worker-test-secret')

    expect(result).toBeNull()
    expect(globalKeys).toEqual(['192.0.2.10'])
    expect(botKeys).toEqual([])
})

test('authenticated bot requests use the separate limit', async () => {
    const globalKeys: string[] = []
    const botKeys: string[] = []
    const request = new Request('https://apis.trptools.com/bot/internal/due/lease', {
        headers: { authorization: 'Bearer worker-test-secret' }
    })
    const result = await checkWorkerRateLimit(request, {
        GLOBAL_RATE_LIMIT: limiter(false, globalKeys),
        BOT_RATE_LIMIT: limiter(true, botKeys)
    }, 'worker-test-secret')

    expect(result).toBeNull()
    expect(globalKeys).toEqual([])
    expect(botKeys).toEqual(['authenticated'])
})

test('native limit returns 429 with retry header', async () => {
    const request = new Request('https://apis.trptools.com/health')
    const response = await checkWorkerRateLimit(request, {
        GLOBAL_RATE_LIMIT: limiter(false, []),
        BOT_RATE_LIMIT: limiter(true, [])
    }, 'worker-test-secret')
    expect(response?.status).toBe(429)
    expect(response?.headers.get('retry-after')).toBe('60')
    expect(response?.headers.get('x-ratelimit-source')).toBe('trptools')
})
