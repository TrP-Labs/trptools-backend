import { expect, test } from 'bun:test'
import { retryDelay, validPushEndpoint, validPushKeys } from './rules'

test('push destinations are an HTTPS provider allowlist, including Windows regional hosts', () => {
    for (const url of ['https://fcm.googleapis.com/fcm/send/secret', 'https://updates.push.services.mozilla.com/wpush/v2/key', 'https://web.push.apple.com/Q/key', 'https://wns2.notify.windows.com/w/?token=key']) expect(validPushEndpoint(url)).toBe(true)
    for (const url of ['http://fcm.googleapis.com/key', 'https://fcm.googleapis.com.evil.com/key', 'https://user:password@fcm.googleapis.com/key', 'https://127.0.0.1/key', 'https://fcm.googleapis.com:444/key', 'file:///tmp/key', 'https://evil.notify.windows.com.evil/key', 'not-a-url']) expect(validPushEndpoint(url)).toBe(false)
})
test('subscription keys have the correct binary sizes and public-key encoding', () => {
    const key = new Uint8Array(65); key[0] = 4
    const keys = { p256dh: Buffer.from(key).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }
    expect(validPushKeys(keys)).toBe(true)
    expect(validPushKeys({ ...keys, p256dh: 'bad' })).toBe(false)
    expect(validPushKeys({ ...keys, auth: 'bad' })).toBe(false)
    key[0] = 3
    expect(validPushKeys({ ...keys, p256dh: Buffer.from(key).toString('base64url') })).toBe(false)
})
test('retry delays respect rate limits and remain bounded', () => {
    expect(retryDelay(1, null)).toBe(30)
    expect(retryDelay(3, '300')).toBe(300)
    expect(retryDelay(5, '999999')).toBe(900)
    expect(retryDelay(1, '-1')).toBe(30)
})
