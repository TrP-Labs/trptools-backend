import { inArray } from 'drizzle-orm'
import db from '../db'
import { media } from '../db/schema'
import { publicUrl } from '../utils/storage'

/**
 * Resolve icons and banners from their keys so storage configuration changes
 * apply to existing uploads too. Withheld or deleted media has no public URL.
 */
export async function mediaUrls(ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
    if (wanted.length === 0) return new Map()

    const rows = await db
        .select({ id: media.id, key: media.key, moderation: media.moderation })
        .from(media)
        .where(inArray(media.id, wanted))

    return new Map(
        rows.filter((row) => row.moderation !== 'HIDDEN').map((row) => [row.id, publicUrl(row.key)])
    )
}
