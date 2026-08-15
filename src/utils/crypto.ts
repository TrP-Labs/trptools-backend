import { sha256 } from '@oslojs/crypto/sha2'
import { decodeBase64, encodeBase64 } from '@oslojs/encoding'
import { env } from './env'

/**
 * AES-256-GCM for secrets we must be able to read back: Roblox OAuth refresh
 * tokens and group-owned Open Cloud API keys. Session tokens and TrPTools API
 * keys are hashed instead, never encrypted, because we never need the original.
 */

/** Widens a view to a plain ArrayBuffer, which is what WebCrypto expects. */
function toBuffer(view: Uint8Array): ArrayBuffer {
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

const keyPromise = crypto.subtle.importKey(
    'raw',
    toBuffer(sha256(new TextEncoder().encode(env.ENCRYPTION_KEY))),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
)

export async function encryptSecret(plaintext: string): Promise<string> {
    const key = await keyPromise
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBuffer(new TextEncoder().encode(plaintext)))
    )

    const payload = new Uint8Array(iv.length + ciphertext.length)
    payload.set(iv, 0)
    payload.set(ciphertext, iv.length)

    return encodeBase64(payload)
}

export async function decryptSecret(encoded: string | null | undefined): Promise<string | null> {
    if (!encoded) return null

    try {
        const key = await keyPromise
        const payload = decodeBase64(encoded)
        if (payload.length <= 12) return null

        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: payload.slice(0, 12) },
            key,
            toBuffer(payload.slice(12))
        )

        return new TextDecoder().decode(plaintext)
    } catch {
        // A rotated ENCRYPTION_KEY invalidates old ciphertext rather than
        // crashing the request; callers treat null as "not configured".
        return null
    }
}

/** Constant-time string comparison for secret material. */
export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let mismatch = 0
    for (let index = 0; index < a.length; index += 1) {
        mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
    }
    return mismatch === 0
}
