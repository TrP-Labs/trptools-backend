import { t } from 'elysia'
import { globalModel } from '../../utils/globalModel'
import { MediaModel } from '../../media/model'
import { translationsPatch, translationsResponse } from '../../utils/translations'

export namespace RouteModel {
    export const routeShape = t.Union([
        t.Literal('AUTO'),
        t.Literal('CIRCLE'),
        t.Literal('RECTANGLE'),
        t.Literal('DIAMOND'),
        t.Literal('HEXAGON')
    ])
    export type routeShape = typeof routeShape.static

    export const moderation = t.Union([t.Literal('VISIBLE'), t.Literal('HIDDEN'), t.Literal('APPROVED')])

    // ------------------------------------------------------------- depots

    export const depotBody = t.Object({
        id: t.String(),
        groupId: t.String(),

        number: t.Number(),
        name: t.String(),
        slug: t.String(),
        description: t.String(),
        color: t.String(),

        /** Other names the game may report for this depot. */
        aliases: t.Array(t.String()),

        /** Public URL of the uploaded icon, when one is set. */
        icon: t.Union([t.String(), t.Null()]),
        iconMediaId: t.Union([t.String(), t.Null()]),

        visibility: globalModel.visibility,
        moderation: moderation,

        /** Whether the group's public page lists this depot. */
        showOnGroupPage: t.Boolean(),

        order: t.Number(),
        archived: t.Boolean(),

        images: MediaModel.list,

        /**
         * Per-language versions of this row's text, as
         * `{ field: { locale: text } }`.
         *
         * Shipped with the row rather than resolved server-side. Public reads
         * never consult the session so they stay CDN-cacheable (§9), and
         * resolving here would mean either a locale on every one of them —
         * and a cache entry per language — or a header the cache has to vary
         * on. The site knows which language it is drawing in, the payload is
         * a handful of short strings, and the dashboard needs all of them
         * anyway to put them in the editor.
         */
        translations: translationsResponse,

        createdAt: t.Date(),
        updatedAt: t.Date()
    })
    export type depotBody = typeof depotBody.static

    export const depotList = t.Array(depotBody)
    export type depotList = typeof depotList.static

    export const createDepotBody = t.Object({
        groupId: t.String(),
        number: t.Integer({ minimum: 0, maximum: 9999 }),
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 2000 })),
        color: t.Optional(globalModel.hexColor),
        aliases: t.Optional(t.Array(t.String({ maxLength: 60 }), { maxItems: 12 })),
        visibility: t.Optional(globalModel.visibility),
        showOnGroupPage: t.Optional(t.Boolean()),
        /** Per-language versions of the text fields above. */
        translations: t.Optional(translationsPatch),

        order: t.Optional(t.Integer({ minimum: 0, maximum: 9999 }))
    })
    export type createDepotBody = typeof createDepotBody.static

    export const patchDepotBody = t.Object({
        number: t.Optional(t.Integer({ minimum: 0, maximum: 9999 })),
        name: t.Optional(t.String({ minLength: 1, maxLength: 60 })),
        description: t.Optional(t.String({ maxLength: 2000 })),
        color: t.Optional(globalModel.hexColor),
        aliases: t.Optional(t.Array(t.String({ maxLength: 60 }), { maxItems: 12 })),
        iconMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        visibility: t.Optional(globalModel.visibility),
        showOnGroupPage: t.Optional(t.Boolean()),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 9999 })),
        /** Per-language versions of the text fields above. */
        translations: t.Optional(translationsPatch),

        archived: t.Optional(t.Boolean())
    })
    export type patchDepotBody = typeof patchDepotBody.static

    export const depotQuery = t.Object({
        groupId: t.String(),
        includeArchived: t.Optional(t.String())
    })
    export type depotQuery = typeof depotQuery.static

    export const numberTaken = t.Literal('a depot with that number already exists')
    export type numberTaken = typeof numberTaken.static

    // ------------------------------------------------------------- routes

    export const routeBody = t.Object({
        id: t.String(),
        groupId: t.String(),

        name: t.String(),
        slug: t.String(),
        description: t.String(),

        color: t.String(),
        textColor: t.String(),
        shape: routeShape,

        /** Public URL of the uploaded badge, when one is set. */
        icon: t.Union([t.String(), t.Null()]),
        iconMediaId: t.Union([t.String(), t.Null()]),

        /** Percentage of dispatchable vehicles this route should carry. */
        targetShare: t.Number(),
        autoAssign: t.Boolean(),
        order: t.Number(),
        archived: t.Boolean(),
        builtIn: t.Boolean(),

        visibility: globalModel.visibility,
        moderation: moderation,

        /** Whether the group's public page lists this route. */
        showOnGroupPage: t.Boolean(),

        /** Depot ids this route can be dispatched from. Empty means all. */
        depots: t.Array(t.String()),
        images: MediaModel.list,

        /**
         * Per-language versions of this row's text, as
         * `{ field: { locale: text } }`.
         *
         * Shipped with the row rather than resolved server-side. Public reads
         * never consult the session so they stay CDN-cacheable (§9), and
         * resolving here would mean either a locale on every one of them —
         * and a cache entry per language — or a header the cache has to vary
         * on. The site knows which language it is drawing in, the payload is
         * a handful of short strings, and the dashboard needs all of them
         * anyway to put them in the editor.
         */
        translations: translationsResponse,

        createdAt: t.Date(),
        updatedAt: t.Date()
    })
    export type routeBody = typeof routeBody.static

    export const routesResponse = t.Array(routeBody)
    export type routesResponse = typeof routesResponse.static

    /**
     * A route's share of its depot's vehicles.
     *
     * Fractional so three routes can split a depot evenly. The service rounds
     * to two decimal places rather than the schema declaring `multipleOf`,
     * which compares floats exactly and so rejects ordinary values like 20 and
     * 33.33.
     */
    export const targetShare = t.Number({ minimum: 0, maximum: 100 })

    export const createRouteBody = t.Object({
        groupId: t.String(),
        name: t.String({ minLength: 1, maxLength: 24 }),
        description: t.Optional(t.String({ maxLength: 1000 })),
        color: t.Optional(globalModel.hexColor),
        textColor: t.Optional(globalModel.hexColor),
        shape: t.Optional(routeShape),
        targetShare: t.Optional(targetShare),
        autoAssign: t.Optional(t.Boolean()),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 9999 })),
        visibility: t.Optional(globalModel.visibility),
        showOnGroupPage: t.Optional(t.Boolean()),
        /** Per-language versions of the text fields above. */
        translations: t.Optional(translationsPatch),

        depots: t.Optional(t.Array(t.String({ format: 'uuid' }), { maxItems: 64 }))
    })
    export type createRouteBody = typeof createRouteBody.static

    export const patchRouteBody = t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 24 })),
        description: t.Optional(t.String({ maxLength: 1000 })),
        color: t.Optional(globalModel.hexColor),
        textColor: t.Optional(globalModel.hexColor),
        shape: t.Optional(routeShape),
        targetShare: t.Optional(targetShare),
        autoAssign: t.Optional(t.Boolean()),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 9999 })),
        archived: t.Optional(t.Boolean()),
        iconMediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        visibility: t.Optional(globalModel.visibility),
        showOnGroupPage: t.Optional(t.Boolean()),
        /** Per-language versions of the text fields above. */
        translations: t.Optional(translationsPatch),

        depots: t.Optional(t.Array(t.String({ format: 'uuid' }), { maxItems: 64 }))
    })
    export type patchRouteBody = typeof patchRouteBody.static

    export const routeIdResponse = t.Object({ id: t.String() })
    export type routeIdResponse = typeof routeIdResponse.static

    export const routesRequest = t.Object({
        groupId: t.String(),
        includeArchived: t.Optional(t.String())
    })
    export type routesRequest = typeof routesRequest.static

    export const nameTaken = t.Literal('a route with that name already exists')
    export type nameTaken = typeof nameTaken.static

    export const builtInProtected = t.Literal('built-in routes can be disabled but not deleted')
    export type builtInProtected = typeof builtInProtected.static
}
