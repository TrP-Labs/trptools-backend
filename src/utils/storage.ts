import { S3Client } from 'bun'
import { env } from './env'

/**
 * S3-compatible object storage.
 *
 * Bun ships an S3 client, so this needs no dependency and talks to MinIO,
 * Garage, Ceph, Cloudflare R2 or AWS unchanged — whatever the deployment has.
 * The compose file runs MinIO.
 */
export const storageConfigured = Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY)

const client = storageConfigured
    ? new S3Client({
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
          bucket: env.S3_BUCKET,
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION
      })
    : null

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
    await client.write(key, bytes, { type: contentType, acl: 'public-read' })
}

export async function deleteObject(key: string) {
    if (!client) return
    await client.delete(key).catch(() => undefined)
}

/** The browser-facing URL for an object. */
export function publicUrl(key: string): string {
    const base = (env.S3_PUBLIC_URL || env.S3_ENDPOINT).replace(/\/$/, '')
    return `${base}/${env.S3_BUCKET}/${key}`
}
