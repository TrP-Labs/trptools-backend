import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'
import { translationsPatch, translationsResponse } from '../utils/translations'

export namespace SignupModel {
    /**
     * A rank list, as ids of `rank_relations` rows.
     *
     * **Empty means every member of the group.** A sheet is created with no
     * ranks on it, and reading that as "nobody" would make a newly built sheet
     * look finished and refuse everyone; the editor says which of the two a
     * list currently means rather than leaving it to be found out.
     */
    const rankIds = t.Array(t.String({ format: 'uuid' }), { maxItems: 50 })

    export const slotResponse = t.Object({
        id: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        capacity: t.Number(),
        order: t.Number(),
        /** In force only while the sheet's `uniformRanks` is off. */
        rankIds: t.Array(t.String())
    })
    export type slotResponse = typeof slotResponse.static

    export const sheetResponse = t.Object({
        id: t.String(),
        groupId: t.String(),
        enabled: t.Boolean(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        color: t.String(),
        /** Whether the sheet's own rank list applies to every slot. */
        uniformRanks: t.Boolean(),
        order: t.Number(),
        rankIds: t.Array(t.String()),
        discordChannel: t.Union([t.String(), t.Null()]),
        discordPingRole: t.Union([t.String(), t.Null()]),
        slots: t.Array(slotResponse)
    })
    export type sheetResponse = typeof sheetResponse.static

    export const sheetsResponse = t.Array(sheetResponse)
    export type sheetsResponse = typeof sheetsResponse.static

    export const listRequest = t.Object({ groupId: t.String() })
    export type listRequest = typeof listRequest.static

    export const createBody = t.Object({
        groupId: t.String(),
        name: t.String({ minLength: 1, maxLength: 60 }),
        color: t.Optional(globalModel.hexColor)
    })
    export type createBody = typeof createBody.static

    export const createResponse = t.Object({ id: t.String() })
    export type createResponse = typeof createResponse.static

    /** Snowflakes are 64-bit; they travel as digit strings, never numbers. */
    const snowflake = t.Union([t.String({ pattern: '^[0-9]{15,25}$' }), t.Null()])

    export const updateBody = t.Object({
        enabled: t.Optional(t.Boolean()),
        name: t.Optional(t.String({ minLength: 1, maxLength: 60 })),
        description: t.Optional(t.String({ maxLength: 300 })),
        /** Per-language versions of the sheet's name and description. */
        translations: t.Optional(translationsPatch),
        color: t.Optional(globalModel.hexColor),
        uniformRanks: t.Optional(t.Boolean()),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 999 })),
        /** The sheet's own rank list. Replaced wholesale when sent. */
        rankIds: t.Optional(rankIds),
        discordChannel: t.Optional(snowflake),
        discordPingRole: t.Optional(snowflake)
    })
    export type updateBody = typeof updateBody.static

    export const slotInput = t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 300 })),
        /** Per-language versions of this slot's name and description. */
        translations: t.Optional(translationsPatch),
        capacity: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 999 })),
        /** Ignored while the sheet's `uniformRanks` is on, but still stored. */
        rankIds: t.Optional(rankIds)
    })
    export type slotInput = typeof slotInput.static

    export const slotsBody = t.Object({
        slots: t.Array(slotInput, { maxItems: 25 })
    })
    export type slotsBody = typeof slotsBody.static

    /**
     * A bound rank, for the sheet editor's rank picker.
     *
     * Served from here rather than reused from `/ranks`, which asks for
     * `MANAGE_RANKS`: whoever builds sheets should not need the grant that
     * decides what every rank in the group may do, and a picker that 403s is
     * a sheet that cannot be configured.
     */
    export const pickableRank = t.Object({
        id: t.String(),
        name: t.String(),
        rank: t.Number(),
        color: t.String()
    })
    export const pickableRanksResponse = t.Array(pickableRank)
    export type pickableRanksResponse = typeof pickableRanksResponse.static

    export const sheetInvalid = t.Literal('sign-up sheet does not exist')
    export type sheetInvalid = typeof sheetInvalid.static
}
