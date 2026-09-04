import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'
import { SUPPORTED_LOCALES } from '../utils/locales'
import { translationsPatch, translationsResponse } from '../utils/translations'

/** A language tag this instance knows. See `BotModel` for why it is a pattern. */
const sourceLocale = t.String({ pattern: `^(${SUPPORTED_LOCALES.join('|')})$` })

export namespace GroupModel {
    export const createGroupBody = t.Object({
        robloxId: t.String({ pattern: '^\\d+$' })
    })
    export type createGroupBody = typeof createGroupBody.static

    export const createGroupResponse = t.Object({
        id: t.String(),
        slug: t.String()
    })
    export type createGroupResponse = typeof createGroupResponse.static

    /** The shape used everywhere a group is listed or opened. */
    export const groupResponse = t.Object({
        id: t.String(),
        slug: t.String(),
        createdAt: t.Date(),

        robloxId: t.String(),
        /** What the group is called here, which may not be its Roblox name. */
        name: t.String(),
        /**
         * The Roblox name, so settings can offer to go back to following it.
         * Null when Roblox has never been reachable for this group.
         */
        robloxName: t.Union([t.String(), t.Null()]),
        /** Whether `name` is the group's own or Roblox's. */
        nameIsCustom: t.Boolean(),
        description: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        members: t.Number(),

        visibility: globalModel.visibility,
        tagline: t.String(),
        about: t.String(),
        /**
         * The language this group writes in, which everything it types falls
         * back to. Never assumed to be English — it is set on registration
         * from whoever registered the group.
         */
        sourceLocale: t.String(),
        /** Per-language versions of the name, tagline and about text. */
        translations: translationsResponse,
        accentColor: t.String(),
        bannerImage: t.Union([t.String(), t.Null()]),
        bannerMediaId: t.Union([t.String(), t.Null()]),

        showRoutes: t.Boolean(),
        showShifts: t.Boolean(),
        showRoster: t.Boolean(),
        showDispatch: t.Boolean(),

        /** Minutes before a shift starts that its dispatch room may open. */
        roomOpenLeadMinutes: t.Number(),
        signupLeadMinutes: t.Number(),

        /** The requesting user's permission level, 0-3. */
        permissionLevel: t.Number(),
        hasOpenCloudKey: t.Boolean(),
        moderation: t.Union([t.Literal('VISIBLE'), t.Literal('HIDDEN'), t.Literal('APPROVED')])
    })
    export type groupResponse = typeof groupResponse.static

    export const groupSummary = t.Object({
        id: t.String(),
        slug: t.String(),
        robloxId: t.String(),
        name: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        members: t.Number(),
        tagline: t.String(),
        sourceLocale: t.String(),
        /** Per-language versions of the name and tagline. */
        translations: translationsResponse,
        accentColor: t.String(),
        visibility: globalModel.visibility,
        permissionLevel: t.Number()
    })
    export type groupSummary = typeof groupSummary.static

    export const groupList = t.Array(groupSummary)
    export type groupList = typeof groupList.static

    export const creatableGroup = t.Object({
        robloxId: t.String(),
        name: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        members: t.Number()
    })
    export const creatableGroupList = t.Array(creatableGroup)
    export type creatableGroupList = typeof creatableGroupList.static

    export const updateGroupBody = t.Object({
        visibility: t.Optional(globalModel.visibility),
        slug: t.Optional(t.String({ minLength: 3, maxLength: 48 })),
        /**
         * What the group calls itself here. Blank puts it back to following
         * the Roblox name, which is what a group has until it types one.
         */
        name: t.Optional(t.String({ maxLength: 100 })),
        tagline: t.Optional(t.String({ maxLength: 160 })),
        about: t.Optional(t.String({ maxLength: 4000 })),
        /** The language the fields above are written in. */
        sourceLocale: t.Optional(sourceLocale),
        /** Per-language versions of the name, tagline and about text. */
        translations: t.Optional(translationsPatch),
        accentColor: t.Optional(globalModel.hexColor),
        showRoutes: t.Optional(t.Boolean()),
        showShifts: t.Optional(t.Boolean()),
        showRoster: t.Optional(t.Boolean()),
        showDispatch: t.Optional(t.Boolean()),
        roomOpenLeadMinutes: t.Optional(t.Integer({ minimum: 0, maximum: 120 })),
        /** Minutes before a shift that its sign-up sheets open. Up to 30 days. */
        signupLeadMinutes: t.Optional(t.Integer({ minimum: 0, maximum: 43200 }))
    })
    export type updateGroupBody = typeof updateGroupBody.static

    /**
     * One vehicle model the game reports, and which dispatch list it belongs
     * in. Names are matched exactly, so this is a table of vehicles rather
     * than a pattern language nobody would want to author.
     */
    export const vehicleType = t.Object({
        id: t.String(),
        name: t.String(),
        category: t.Union([
            t.Literal('TROLLEYBUS'),
            t.Literal('SERVICE'),
            t.Literal('STAFF'),
            t.Literal('OTHER')
        ])
    })
    export type vehicleType = typeof vehicleType.static

    export const vehicleTypeList = t.Array(vehicleType)
    export type vehicleTypeList = typeof vehicleTypeList.static

    export const updateVehicleTypesBody = t.Object({
        types: t.Array(
            t.Object({
                name: t.String({ minLength: 1, maxLength: 120 }),
                category: vehicleType.properties.category
            }),
            { maxItems: 200 }
        )
    })
    export type updateVehicleTypesBody = typeof updateVehicleTypesBody.static

    export const duplicateVehicleType = t.Literal('two vehicles share a name')
    export type duplicateVehicleType = typeof duplicateVehicleType.static

    export const openCloudKeyBody = t.Object({
        apiKey: t.Union([t.String({ minLength: 20, maxLength: 4000 }), t.Null()])
    })
    export type openCloudKeyBody = typeof openCloudKeyBody.static

    /** Who performed an audited change. Null when the actor was removed. */
    export const auditActor = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        displayName: t.Union([t.String(), t.Null()]),
        username: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()])
    })

    export const auditItem = t.Object({
        id: t.String(),
        action: t.String(),
        summary: t.String(),
        actor: t.Union([auditActor, t.Null()]),
        date: t.Date()
    })
    export const auditList = t.Array(auditItem)
    export type auditList = typeof auditList.static

    export const groupInvalid = t.Literal('group does not exist')
    export type groupInvalid = typeof groupInvalid.static

    export const groupExists = t.Literal('group already exists')
    export type groupExists = typeof groupExists.static

    export const slugTaken = t.Literal('slug is unavailable')
    export type slugTaken = typeof slugTaken.static

    export const invalidKey = t.Literal('api key cannot read this group')
    export type invalidKey = typeof invalidKey.static

    /**
     * Why a key was refused, in words the person pasting it can act on.
     *
     * Open Cloud takes only user-owned keys, and a group-owned one is the
     * mistake almost everybody makes, so it gets its own message rather than
     * being folded into a general failure.
     */
    export const keyGroupOwned = t.Literal(
        'that key belongs to the group — Roblox Open Cloud only accepts keys owned by a user account'
    )
    export type keyGroupOwned = typeof keyGroupOwned.static

    export const keyRejected = t.Literal('roblox rejected that key — check it was copied whole and is not revoked')
    export type keyRejected = typeof keyRejected.static

    export const keyRateLimited = t.Literal('roblox is rate limiting that key — try again in a minute')
    export type keyRateLimited = typeof keyRateLimited.static

    export const keyUnreachable = t.Literal('could not reach roblox to check that key — try again shortly')
    export type keyUnreachable = typeof keyUnreachable.static

    export const keyProblem = t.Union([invalidKey, keyGroupOwned, keyRejected, keyRateLimited, keyUnreachable])
    export type keyProblem = typeof keyProblem.static
}
