import { t } from 'elysia'
import { translationsPatch, translationsResponse } from '../utils/translations'
export namespace ClaimableModel {
    export const fields = {
        name: t.String({ minLength: 1, maxLength: 100 }), description: t.String({ maxLength: 4000 }),
        color: t.String({ pattern: '^#[0-9a-fA-F]{6}$' }), rankId: t.String({ format: 'uuid' }),
        enabled: t.Boolean(), minimumAccountAgeDays: t.Integer({ minimum: 0, maximum: 36500 }),
        requireDiscord: t.Boolean(), maximumRank: t.Integer({ minimum: 1, maximum: 254 })
    }
    export const create = t.Object({ groupId: t.String(), name: fields.name, rankId: fields.rankId })
    export const patch = t.Partial(t.Object({ ...fields, translations: translationsPatch }))
    export type Patch = typeof patch.static
    export type Create = typeof create.static
    export const item = t.Object({ ...fields, rankId: t.Nullable(fields.rankId), id: t.String(), groupId: t.String(), slug: t.String(),
        translations: translationsResponse, rankName: t.Nullable(t.String()), rankColor: t.Nullable(t.String()) })
    export const list = t.Array(item)
    export type Item = typeof item.static
    export const ranks = t.Array(t.Object({ id: t.String(), name: t.String(), rank: t.Number(), color: t.String() }))
    export const connection = t.Object({ hasWriteScope: t.Boolean(), connected: t.Boolean(), authorizedByMe: t.Boolean() })
    export const standing = t.Object({ member: t.Nullable(t.Boolean()), rank: t.Nullable(t.Boolean()), age: t.Nullable(t.Boolean()),
        discord: t.Boolean(), accountAgeDays: t.Nullable(t.Number()), currentRank: t.Nullable(t.Number()),
        pending: t.Boolean(), connected: t.Boolean(), canClaim: t.Boolean(), alreadyHeld: t.Boolean() })
    export const result = t.Object({ state: t.Union([t.Literal('PENDING'), t.Literal('CONFIRMED')]) })
    export const invalid = t.Literal('This claimable rank is unavailable')
    export const ineligible = t.Literal('You do not meet the requirements for this rank')
    export const unavailable = t.Literal('The group needs to reconnect Roblox rank changes')
    export const rejected = t.Literal('Roblox could not change your rank. Check your rank and try again')
    export const unsafe = t.Literal('You can only offer ranks and rank limits below your own Roblox rank')
    export type invalid = typeof invalid.static
    export type ineligible = typeof ineligible.static
    export type unavailable = typeof unavailable.static
    export type rejected = typeof rejected.static
    export type unsafe = typeof unsafe.static
}
