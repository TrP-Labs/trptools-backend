import { status } from 'elysia'
import db from '../db'
import { media } from '../db/schema'
import {
    ALLOWED_IMAGE_TYPES,
    MAX_UPLOAD_BYTES,
    buildKey,
    sniffImageType,
    putObject,
    deleteObject,
    publicUrl,
    storageConfigured,
} from '../utils/storage'

/** Discord attachment URLs are signed and expire; keep a validated copy in our storage. */
export async function saveDiscordImage(
    groupId: string,
    eventId: string,
    value: string,
): Promise<string> {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw status(400, 'Bad Request')
    }
    if (
        url.protocol !== 'https:' ||
        !['cdn.discordapp.com', 'media.discordapp.net'].includes(
            url.hostname,
        ) ||
        !url.pathname.startsWith('/attachments/')
    )
        throw status(400, 'Bad Request')
    if (!storageConfigured)
        throw status(503, 'image uploads are not configured')
    const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
    })
    if (
        !response.ok ||
        Number(response.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES
    )
        throw status(400, 'that file is not a supported image')
    const reader = response.body?.getReader()
    if (!reader) throw status(400, 'that file is not a supported image')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_UPLOAD_BYTES) {
            await reader.cancel()
            throw status(413, 'that file is not a supported image')
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    const contentType = sniffImageType(bytes)
    if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType))
        throw status(400, 'that file is not a supported image')
    const key = buildKey(groupId, contentType)
    await putObject(key, bytes, contentType)
    try {
        await db
            .insert(media)
            .values({
                groupId,
                ownerType: 'SHIFT',
                ownerId: eventId,
                key,
                contentType,
                size,
            })
    } catch (error) {
        await deleteObject(key)
        throw error
    }
    return publicUrl(key)
}
