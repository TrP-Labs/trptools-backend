import { AwsClient } from 'aws4fetch'
import { env } from './env'

/**
 * S3-compatible object storage.
 *
 * Signing plain Fetch requests keeps this client usable in both Bun and
 * Workers while still talking to MinIO, Garage, Cloudflare R2 or AWS.
 */
export const storageConfigured = Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY)

const client = storageConfigured
    ? new AwsClient({
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
          service: 's3',
          region: env.S3_REGION,
          retries: 3
      })
    : null

const objectUrl = (key: string) =>
    `${env.S3_ENDPOINT}/${encodeURIComponent(env.S3_BUCKET)}/${key
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`

/** Image types we accept. Anything else is rejected before it reaches storage. */
export const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
}

/**
 * Magic-number check.
 *
 * The declared content type is attacker-controlled, so it is verified against
 * the actual bytes. Without this a caller could upload anything at all and have
 * us serve it back under an image content type.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
    if (bytes.length < 12) return null

    const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)

    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
    if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
    if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif'

    // RIFF....WEBP
    if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) {
        return 'image/webp'
    }

    return null
}

export function buildKey(groupId: string, contentType: string): string {
    const extension = EXTENSIONS[contentType] ?? 'bin'
    const random = crypto.randomUUID()
    return `groups/${groupId}/${random}.${extension}`
}

export async function putObject(key: string, bytes: Uint8Array, contentType: string) {
    if (!client) throw new Error('Object storage is not configured')
    // Public access belongs to the bucket policy/domain; R2 does not support ACLs.
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const response = await client.fetch(objectUrl(key), {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body
    })
    if (!response.ok) throw new Error(`Object storage PUT failed with ${response.status}`)
}

export async function deleteObject(key: string) {
    if (!client) return
    await client
        .fetch(objectUrl(key), { method: 'DELETE' })
        .then((response) => {
            if (!response.ok && response.status !== 404) {
                throw new Error(`Object storage DELETE failed with ${response.status}`)
            }
        })
        .catch(() => undefined)
}

/** The browser-facing URL for an object. */
export function publicUrl(key: string): string {
    const base = env.S3_PUBLIC_URL || `${env.S3_ENDPOINT}/${env.S3_BUCKET}`
    return `${base.replace(/\/+$/, '')}/${key}`
}
