import { t } from 'elysia'
import { globalModel } from '../../utils/globalModel'

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
