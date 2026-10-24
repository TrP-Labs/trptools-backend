import { t } from 'elysia'
import { PERIOD_PATTERN } from './points'

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
        noShowPoints: points,
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
        noShowPoints: points,
        promotionRankId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
        demotionRankId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
        slots: t.Array(t.Object({ slotId: t.String({ format: 'uuid' }), points }), { maxItems: 500 })
    })
    export type SettingsBody = typeof settingsBody.static

    /** A month (`2026-10`) or a calendar quarter (`2026-Q4`). */
    export const period = t.String({ pattern: PERIOD_PATTERN })

    export const reason = t.Union([
        t.Literal('SIGNED_UP'), t.Literal('TAKEN_AT_WORD'), t.Literal('PRESENT'),
        t.Literal('NO_SHOW'), t.Literal('SHORT'), t.Literal('ABSENT')
    ])

    /** One person on one shift: only the shifts they were seen on or signed up for are sent. */
    export const cell = t.Object({
        shiftId: t.String(),
        points: t.Number(),
        reason,
        /** Share of the shift on the server; null where no server tracked it. */
        percent: t.Union([t.Number(), t.Null()]),
        slot: t.Union([t.String(), t.Null()]),
        /** Careers reported during this shift; empty for older feeds and history. */
        jobs: t.Array(t.String())
    })

    export const verdict = t.Union([t.Literal('PROMOTE'), t.Literal('DEMOTE'), t.Null()])

    export const standing = t.Object({
        robloxId: t.String(),
        name: t.String(),
        avatar: t.Union([t.String(), t.Null()]),
        rankId: t.String(),
        rankName: t.String(),
        rankColor: t.String(),
        /** Roblox's 0-255 ordering, so a sheet can sort by seniority. */
        rankOrder: t.Number(),
        /** The rank is on the public staff list, which files the person under Staff. */
        staff: t.Boolean(),
        /** Set aside: still counted, never suggested for a promotion or demotion. */
        paused: t.Boolean(),
        points: t.Number(),
        /** Shifts that earned anything this period. */
        shifts: t.Number(),
        cells: t.Array(cell),
        minPoints: nullablePoints,
        maxPoints: nullablePoints,
        verdict,
        targetRankId: t.Union([t.String(), t.Null()]),
        targetRankName: t.Union([t.String(), t.Null()])
    })

    export const standings = t.Object({
        period: t.String(),
        /** How many months the period spans; the bounds below are already scaled by it. */
        months: t.Number(),
        /** Every shift in the period that has started, oldest first: the activity sheet's columns. */
        shifts: t.Array(t.Object({ id: t.String(), name: t.String(), color: t.String(), start: t.String(), end: t.String(), tracked: t.Boolean() })),
        /** Ranks with a bound and somewhere to go; the page explains an empty list against this. */
        configuredRanks: t.Number(),
        /** Every rank, so the page can link to each one's rules. */
        ranks: t.Array(t.Object({ id: t.String(), name: t.String(), color: t.String(), rank: t.Number(), configured: t.Boolean(), staff: t.Boolean() })),
        /** May this viewer press the buttons at all, connection aside. */
        canApply: t.Boolean(),
        /** May this viewer pause and unpause people. */
        canPause: t.Boolean(),
        connection: t.Object({ hasWriteScope: t.Boolean(), connected: t.Boolean(), authorizedByMe: t.Boolean() }),
        people: t.Array(standing),
        /** Ranks whose holders could not be listed because Roblox did not answer. */
        incomplete: t.Boolean()
    })
    export type Standings = typeof standings.static

    export const applyBody = t.Object({
        robloxId: t.String({ pattern: '^[0-9]{1,20}$' }),
        verdict: t.Union([t.Literal('PROMOTE'), t.Literal('DEMOTE')]),
        period
    })
    export type ApplyBody = typeof applyBody.static

    export const pauseBody = t.Object({ paused: t.Boolean() })

    export const stale = t.Literal('their standing has changed, refresh and try again')
    export type stale = typeof stale.static
    export const unsafe = t.Literal('you can only move people between ranks below your own')
    export type unsafe = typeof unsafe.static
    export const unreachable = t.Literal('Roblox could not change that rank, try again shortly')
    export type unreachable = typeof unreachable.static
}
