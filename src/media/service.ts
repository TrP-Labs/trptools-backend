import { status } from 'elysia'
import { and, asc, eq, inArray } from 'drizzle-orm'
import db from '../db'
import { applications, depots, groups, media, routes, type Media } from '../db/schema'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertPermission } from '../utils/groupPermission'
import {
    ALLOWED_IMAGE_TYPES,
    MAX_UPLOAD_BYTES,
    buildKey,
    deleteObject,
    publicUrl,
    putObject,
    sniffImageType,
    storageConfigured
} from '../utils/storage'
import type { session } from '../utils/sessionVerifier'
import { findGroup, recordAudit } from '../groups/service'
import { MediaModel } from './model'

const MAX_PER_OWNER = 12

export function present(row: Media): MediaModel.item {
    return {
        id: row.id,
        url: publicUrl(row.key),
        caption: row.caption,
        order: row.order,
        contentType: row.contentType,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        moderation: row.moderation,
        createdAt: row.createdAt
    }
}

/** Loads visible images for a set of owners, keyed by owner id. */
export async function mediaForOwners(
    ownerType: MediaModel.ownerType,
    ownerIds: string[],
    includeHidden = false
): Promise<Map<string, MediaModel.item[]>> {
    const grouped = new Map<string, MediaModel.item[]>()
    if (ownerIds.length === 0) return grouped

    const rows = await db
        .select()
        .from(media)
        .where(and(eq(media.ownerType, ownerType), inArray(media.ownerId, ownerIds)))
        .orderBy(asc(media.order), asc(media.createdAt))

    for (const row of rows) {
        if (!row.ownerId) continue
        if (!includeHidden && row.moderation === 'HIDDEN') continue

        const bucket = grouped.get(row.ownerId) ?? []
        bucket.push(present(row))
        grouped.set(row.ownerId, bucket)
    }

    return grouped
}

/**
 * Public URLs for a handful of media rows, keyed by id.
 *
 * Icons and banners are referenced by id from the row that uses them rather
 * than listed with the galleries, so they need a lookup of their own. A
 * withheld image resolves to nothing, which drops the caller back to its
 * built-in presentation instead of showing reported content.
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

/**
 * The row that owns a badge or banner, and how to repoint it.
 *
 * Groups, routes and depots each store their image on a different column, so
 * the differences are resolved once here rather than branching through both
 * the set and the clear path.
 */
async function resolveIconOwner(groupId: string, ownerType: MediaModel.ownerType, ownerId?: string) {
    // Application forms have no single image of their own — their pictures are
    // components in the form, uploaded to the gallery and referenced by id.
    if (ownerType === 'APPLICATION') throw status(400, 'Bad Request' satisfies globalModel.badRequest)

    if (ownerType === 'GROUP') {
        const [group] = await db
            .select({ mediaId: groups.bannerMediaId })
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return {
            ownerId: null,
            label: 'banner',
            currentMediaId: group.mediaId,
            // The URL is denormalised onto the group so reading a public page
            // stays a single query.
            link: async (mediaId: string | null, url: string | null) => {
                await db
                    .update(groups)
                    .set({ bannerMediaId: mediaId, bannerImage: url })
                    .where(eq(groups.id, groupId))
            }
        }
    }

    if (!ownerId) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

    if (ownerType === 'ROUTE') {
        const [route] = await db
            .select({ mediaId: routes.iconMediaId })
            .from(routes)
            .where(and(eq(routes.id, ownerId), eq(routes.groupId, groupId)))
            .limit(1)

        if (!route) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return {
            ownerId,
            label: 'route badge',
            currentMediaId: route.mediaId,
            link: async (mediaId: string | null, _url: string | null) => {
                await db
                    .update(routes)
                    .set({ iconMediaId: mediaId, updatedAt: new Date() })
                    .where(eq(routes.id, ownerId))
            }
        }
    }

    const [depot] = await db
        .select({ mediaId: depots.iconMediaId })
        .from(depots)
        .where(and(eq(depots.id, ownerId), eq(depots.groupId, groupId)))
        .limit(1)

    if (!depot) throw status(404, 'Not Found' satisfies globalModel.notFound)

    return {
        ownerId,
        label: 'depot icon',
        currentMediaId: depot.mediaId,
        link: async (mediaId: string | null, _url: string | null) => {
            await db
                .update(depots)
                .set({ iconMediaId: mediaId, updatedAt: new Date() })
                .where(eq(depots.id, ownerId))
        }
    }
}

/** Tears down a replaced icon. Nothing points at it any more by this stage. */
async function dropIcon(mediaId: string | null) {
    if (!mediaId) return

    const [row] = await db.select({ key: media.key }).from(media).where(eq(media.id, mediaId)).limit(1)
    if (!row) return

    await db.delete(media).where(eq(media.id, mediaId))
    await deleteObject(row.key).catch(() => undefined)
}

export abstract class MediaService {
    static async list(query: MediaModel.listQuery, session: session): Promise<MediaModel.list> {
        const group = await findGroup(query.groupId)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const filters = [eq(media.groupId, group.id)]
        if (query.ownerType) filters.push(eq(media.ownerType, query.ownerType))
        if (query.ownerId) filters.push(eq(media.ownerId, query.ownerId))

        const rows = await db
            .select()
            .from(media)
            .where(and(...filters))
            .orderBy(asc(media.order), asc(media.createdAt))

        // Managers see their own hidden images so they know something was
        // reported rather than silently vanished.
        return rows.map(present)
    }

    static async upload(body: MediaModel.uploadBody, session: session): Promise<MediaModel.item> {
        if (!storageConfigured) {
            throw status(503, 'image uploads are not configured' satisfies MediaModel.storageUnavailable)
        }

        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        if (body.file.size > MAX_UPLOAD_BYTES) {
            throw status(413, 'that file is not a supported image' satisfies MediaModel.notAnImage)
        }

        const bytes = new Uint8Array(await body.file.arrayBuffer())

        // Trust the bytes, not the declared type.
        const sniffed = sniffImageType(bytes)
        if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
            throw status(400, 'that file is not a supported image' satisfies MediaModel.notAnImage)
        }

        // The owner must belong to this group, or a manager of group A could
        // attach images to group B's routes.
        if (body.ownerType !== 'GROUP') {
            if (!body.ownerId) throw status(400, 'Bad Request' satisfies globalModel.badRequest)

            const owner =
                body.ownerType === 'ROUTE' ? routes : body.ownerType === 'DEPOT' ? depots : applications

            const owned = await db
                .select({ id: owner.id })
                .from(owner)
                .where(and(eq(owner.id, body.ownerId), eq(owner.groupId, group.id)))
                .limit(1)

            if (owned.length === 0) throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const ownerId = body.ownerType === 'GROUP' ? null : (body.ownerId ?? null)

        const existing = await db
            .select({ id: media.id })
            .from(media)
            .where(
                and(
                    eq(media.groupId, group.id),
                    eq(media.ownerType, body.ownerType),
                    ownerId ? eq(media.ownerId, ownerId) : eq(media.groupId, group.id)
                )
            )

        if (existing.length >= MAX_PER_OWNER) {
            throw status(409, 'Conflict' satisfies globalModel.conflict)
        }

        const key = buildKey(group.id, sniffed)
        await putObject(key, bytes, sniffed)

        const [row] = await db
            .insert(media)
            .values({
                groupId: group.id,
                ownerType: body.ownerType,
                ownerId,
                key,
                contentType: sniffed,
                size: bytes.byteLength,
                caption: body.caption ?? '',
                order: existing.length,
                uploadedBy: session.user?.userId ?? null
            })
            .returning()

        if (!row) {
            await deleteObject(key)
            throw status(500, 'Internal Server Error' satisfies globalModel.internalError)
        }

        await recordAudit(group.id, session.user?.userId ?? null, 'media.upload', 'Uploaded an image')

        return present(row)
    }

    /**
     * Replaces the badge on a route or depot, or the banner on a group.
     *
     * Upload and linkage happen together: the new row is written, the owner is
     * repointed at it, and only then is the previous image torn down. A
     * failure part way leaves the owner on its old image rather than on
     * nothing.
     */
    static async setIcon(body: MediaModel.iconBody, session: session): Promise<MediaModel.iconResponse> {
        if (!storageConfigured) {
            throw status(503, 'image uploads are not configured' satisfies MediaModel.storageUnavailable)
        }

        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const owner = await resolveIconOwner(group.id, body.ownerType, body.ownerId)

        if (body.file.size > MAX_UPLOAD_BYTES) {
            throw status(413, 'that file is not a supported image' satisfies MediaModel.notAnImage)
        }

        const bytes = new Uint8Array(await body.file.arrayBuffer())

        const sniffed = sniffImageType(bytes)
        if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
            throw status(400, 'that file is not a supported image' satisfies MediaModel.notAnImage)
        }

        const key = buildKey(group.id, sniffed)
        await putObject(key, bytes, sniffed)

        const [row] = await db
            .insert(media)
            .values({
                groupId: group.id,
                ownerType: body.ownerType,
                ownerId: owner.ownerId,
                key,
                contentType: sniffed,
                size: bytes.byteLength,
                uploadedBy: session.user?.userId ?? null
            })
            .returning()

        if (!row) {
            await deleteObject(key)
            throw status(500, 'Internal Server Error' satisfies globalModel.internalError)
        }

        const url = publicUrl(row.key)
        await owner.link(row.id, url)
        await dropIcon(owner.currentMediaId)

        await recordAudit(group.id, session.user?.userId ?? null, 'media.icon', `Updated the ${owner.label} image`)

        return { mediaId: row.id, url }
    }

    static async clearIcon(query: MediaModel.iconTarget, session: session): Promise<MediaModel.iconResponse> {
        const group = await findGroup(query.groupId)
        if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const owner = await resolveIconOwner(group.id, query.ownerType, query.ownerId)

        await owner.link(null, null)
        await dropIcon(owner.currentMediaId)

        await recordAudit(group.id, session.user?.userId ?? null, 'media.icon', `Removed the ${owner.label} image`)

        return { mediaId: null, url: null }
    }

    static async update(id: string, body: MediaModel.patchBody, session: session) {
        const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1)
        if (!row) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, row.groupId, PERMISSION.MANAGE)

        if (Object.keys(body).length > 0) {
            await db.update(media).set(body).where(eq(media.id, id))
        }

        return 'Success' as globalModel.genericSuccess
    }

    static async remove(id: string, session: session) {
        const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1)
        if (!row) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, row.groupId, PERMISSION.MANAGE)

        await db.delete(media).where(eq(media.id, id))
        await deleteObject(row.key)

        await recordAudit(row.groupId, session.user?.userId ?? null, 'media.delete', 'Deleted an image')

        return 'Success' as globalModel.genericSuccess
    }
}
