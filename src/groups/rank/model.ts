import { t } from 'elysia'
import { globalModel } from '../../utils/globalModel'
import { translationsPatch, translationsResponse } from '../../utils/translations'

export namespace RankModel {
    export const createRankBody = t.Object({
        robloxId: t.String({ minLength: 1, maxLength: 32 })
    })
    export type createRankBody = typeof createRankBody.static

    export const createRankResponse = t.Object({ id: t.String() })
    export type createRankResponse = typeof createRankResponse.static

    export const rankItemResponse = t.Object({
        id: t.String(),
        groupId: t.String(),
        robloxId: t.String(),

        cachedName: t.String(),
        cachedRank: t.Number(),

        color: t.String(),
        description: t.String(),
        visible: t.Boolean(),

        permissionLevel: t.Number(),

        maxActivity: t.Union([t.Number(), t.Null()]),
        minActivity: t.Union([t.Number(), t.Null()])
    })
    export type rankItemResponse = typeof rankItemResponse.static

    export const rankListResponse = t.Array(rankItemResponse)
    export type rankListResponse = typeof rankListResponse.static

    export const editRankBody = t.Object({
        color: t.Optional(globalModel.hexColor),
        description: t.Optional(t.String({ maxLength: 300 })),
        visible: t.Optional(t.Boolean()),
        permissionLevel: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
        maxActivity: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
        minActivity: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
        /** Re-reads the role name and rank from Roblox. */
        refresh: t.Optional(t.Boolean())
    })
    export type editRankBody = typeof editRankBody.static

    export const availableRank = t.Object({
        robloxId: t.String(),
        name: t.String(),
        rank: t.Number()
    })
    export const availableRanksResponse = t.Array(availableRank)
    export type availableRanksResponse = typeof availableRanksResponse.static

    // ------------------------------------------------------- sign-up sheets

    export const signupSlotInput = t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 300 })),
        /** Per-language versions of this slot's name and description. */
        translations: t.Optional(translationsPatch),
        capacity: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 999 }))
    })
    export type signupSlotInput = typeof signupSlotInput.static

    export const signupSlot = t.Object({
        id: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        capacity: t.Number(),
        order: t.Number()
    })

    /**
     * A rank's sign-up sheet. `null` where a rank has never been given one,
     * which is what the dashboard shows an empty editor for.
     */
    export const signupResponse = t.Object({
        id: t.String(),
        rankId: t.String(),
        enabled: t.Boolean(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        color: t.String(),
        discordChannel: t.Union([t.String(), t.Null()]),
        discordPingRole: t.Union([t.String(), t.Null()]),
        slots: t.Array(signupSlot)
    })
    export type signupResponse = typeof signupResponse.static

    export const signupOrNull = t.Union([signupResponse, t.Null()])
    export type signupOrNull = typeof signupOrNull.static

    /** Snowflakes are 64-bit; they travel as digit strings, never numbers. */
    const snowflake = t.Union([t.String({ pattern: '^[0-9]{15,25}$' }), t.Null()])

    export const signupBody = t.Object({
        enabled: t.Optional(t.Boolean()),
        name: t.Optional(t.String({ minLength: 1, maxLength: 60 })),
        description: t.Optional(t.String({ maxLength: 300 })),
        /** Per-language versions of the sheet's name and description. */
        translations: t.Optional(translationsPatch),
        color: t.Optional(globalModel.hexColor),
        discordChannel: t.Optional(snowflake),
        discordPingRole: t.Optional(snowflake),
        slots: t.Optional(t.Array(signupSlotInput, { maxItems: 25 }))
    })
    export type signupBody = typeof signupBody.static

    export const rankInvalid = t.Literal('rank does not exist')
    export type rankInvalid = typeof rankInvalid.static

    export const rankExists = t.Literal('rank already exists')
    export type rankExists = typeof rankExists.static

    /** One person holding a rank, for the public roster. */
    export const rosterMember = t.Object({
        robloxId: t.String(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()])
    })

    export const rosterEntry = t.Object({
        rankId: t.String(),
        name: t.String(),
        description: t.String(),
        color: t.String(),
        rank: t.Number(),
        memberCount: t.Number(),
        members: t.Array(rosterMember)
    })

    export const rosterResponse = t.Array(rosterEntry)
    export type rosterResponse = typeof rosterResponse.static
}
