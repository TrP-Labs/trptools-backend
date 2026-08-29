import { t } from 'elysia'

export namespace MediaModel {
    export const ownerType = t.Union([
        t.Literal('GROUP'),
        t.Literal('ROUTE'),
        t.Literal('DEPOT'),
        t.Literal('APPLICATION')
    ])
    export type ownerType = typeof ownerType.static

    export const item = t.Object({
        id: t.String(),
        url: t.String(),
        caption: t.String(),
        order: t.Number(),
        contentType: t.String(),
        ownerType: ownerType,
        ownerId: t.Union([t.String(), t.Null()]),
        moderation: t.Union([t.Literal('VISIBLE'), t.Literal('HIDDEN'), t.Literal('APPROVED')]),
        createdAt: t.Date()
    })
    export type item = typeof item.static

    export const list = t.Array(item)
    export type list = typeof list.static

    export const uploadBody = t.Object({
        file: t.File({ maxSize: '6m' }),
        groupId: t.String(),
        ownerType: ownerType,
        ownerId: t.Optional(t.String()),
        caption: t.Optional(t.String({ maxLength: 200 }))
    })
    export type uploadBody = typeof uploadBody.static

    /**
     * A single image that *replaces* whatever the owner had before — a route
     * or depot badge, or a group banner.
     *
     * These are uploaded and linked in one call so there is no window where an
     * object exists with nothing pointing at it, and no way to accumulate
     * abandoned banners by re-uploading.
     */
    export const iconBody = t.Object({
        file: t.File({ maxSize: '6m' }),
        groupId: t.String(),
        ownerType: ownerType,
        ownerId: t.Optional(t.String())
    })
    export type iconBody = typeof iconBody.static

    export const iconTarget = t.Object({
        groupId: t.String(),
        ownerType: ownerType,
        ownerId: t.Optional(t.String())
    })
    export type iconTarget = typeof iconTarget.static

    export const iconResponse = t.Object({
        mediaId: t.Union([t.String(), t.Null()]),
        url: t.Union([t.String(), t.Null()])
    })
    export type iconResponse = typeof iconResponse.static

    export const listQuery = t.Object({
        groupId: t.String(),
        ownerType: t.Optional(ownerType),
        ownerId: t.Optional(t.String())
    })
    export type listQuery = typeof listQuery.static

    export const patchBody = t.Object({
        caption: t.Optional(t.String({ maxLength: 200 })),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 999 }))
    })
    export type patchBody = typeof patchBody.static

    export const notAnImage = t.Literal('that file is not a supported image')
    export type notAnImage = typeof notAnImage.static

    export const storageUnavailable = t.Literal('image uploads are not configured')
    export type storageUnavailable = typeof storageUnavailable.static
}
