import { t } from 'elysia'

export namespace AttendanceModel {
    const points = t.Number({ minimum: 0, maximum: 1000 })
    const nullablePoints = t.Union([points, t.Null()])

    export const slot = t.Object({
        slotId: t.String(),
        name: t.String(),
        sheetId: t.String(),
        sheetName: t.String(),
        sheetColor: t.String(),
        points
    })

    export const rankOption = t.Object({ id: t.String(), name: t.String(), rank: t.Number() })

    export const settings = t.Object({
        rankId: t.String(),
        /** Enough to title the page for somebody who may keep attendance but not bind ranks. */
        rank: t.Object({ name: t.String(), color: t.String(), rank: t.Number() }),
        minPoints: nullablePoints,
        maxPoints: nullablePoints,
        requiredPercent: t.Integer({ minimum: 0, maximum: 100 }),
        unsignedPoints: points,
        promotionRankId: t.Union([t.String(), t.Null()]),
        demotionRankId: t.Union([t.String(), t.Null()]),
        /** Every slot this rank may sign up for, across the group's enabled sheets. */
        slots: t.Array(slot),
        /** The other ranks a path can lead to. */
        ranks: t.Array(rankOption)
    })
    export type Settings = typeof settings.static

    export const settingsBody = t.Object({
        minPoints: nullablePoints,
        maxPoints: nullablePoints,
        requiredPercent: t.Integer({ minimum: 0, maximum: 100 }),
        unsignedPoints: points,
        promotionRankId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
        demotionRankId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
        slots: t.Array(t.Object({ slotId: t.String({ format: 'uuid' }), points }), { maxItems: 500 })
    })
    export type SettingsBody = typeof settingsBody.static

    export const verdict = t.Union([t.Literal('PROMOTE'), t.Literal('DEMOTE'), t.Null()])

    export const standing = t.Object({
        robloxId: t.String(),
        name: t.String(),
        avatar: t.Union([t.String(), t.Null()]),
        rankId: t.String(),
        rankName: t.String(),
        rankColor: t.String(),
        points: t.Number(),
        /** Shifts that earned anything this month. */
        shifts: t.Number(),
        minPoints: nullablePoints,
        maxPoints: nullablePoints,
        verdict,
        targetRankId: t.Union([t.String(), t.Null()]),
        targetRankName: t.Union([t.String(), t.Null()])
    })

    export const standings = t.Object({
        month: t.String(),
        /** Ranks with a bound and somewhere to go; the page explains an empty list against this. */
        configuredRanks: t.Number(),
        /** Every rank, so the page can link to each one's rules. */
        ranks: t.Array(t.Object({ id: t.String(), name: t.String(), color: t.String(), rank: t.Number(), configured: t.Boolean() })),
        /** May this viewer press the buttons at all, connection aside. */
        canApply: t.Boolean(),
        connection: t.Object({ hasWriteScope: t.Boolean(), connected: t.Boolean(), authorizedByMe: t.Boolean() }),
        people: t.Array(standing),
        /** Ranks whose holders could not be listed because Roblox did not answer. */
        incomplete: t.Boolean()
    })
    export type Standings = typeof standings.static

    export const applyBody = t.Object({
        robloxId: t.String({ pattern: '^[0-9]{1,20}$' }),
        verdict: t.Union([t.Literal('PROMOTE'), t.Literal('DEMOTE')]),
        month: t.String({ pattern: '^[0-9]{4}-[0-9]{2}$' })
    })
    export type ApplyBody = typeof applyBody.static

    export const stale = t.Literal('their standing has changed, refresh and try again')
    export type stale = typeof stale.static
    export const unsafe = t.Literal('you can only move people between ranks below your own')
    export type unsafe = typeof unsafe.static
    export const unreachable = t.Literal('Roblox could not change that rank, try again shortly')
    export type unreachable = typeof unreachable.static
}
