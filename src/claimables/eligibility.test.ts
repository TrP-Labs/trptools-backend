import { describe, expect, test } from 'bun:test'
import { confirmedRoles, qualifications } from './eligibility'
import { creationDate } from '../utils/robloxProfile'
const now = Date.UTC(2026, 8, 30)
const base = { enabled: true, connected: true, currentRank: 10, maximumRank: 20, minimumAccountAgeDays: 30,
    createdAt: new Date(now - 30 * 86_400_000), requireDiscord: true, discordLinked: true }
describe('claim qualifications', () => {
    test('age and current-rank limits are inclusive', () => {
        expect(qualifications({ ...base, currentRank: 20 }, now).canClaim).toBe(true)
        expect(qualifications({ ...base, createdAt: new Date(now - 30 * 86_400_000 + 1) }, now).canClaim).toBe(false)
        expect(qualifications({ ...base, currentRank: 21 }, now).canClaim).toBe(false)
    })
    test('unknown Roblox state never grants a rank', () => {
        expect(qualifications({ ...base, currentRank: null }, now).member).toBeNull()
        expect(qualifications({ ...base, currentRank: null }, now).canClaim).toBe(false)
        expect(qualifications({ ...base, createdAt: null }, now).canClaim).toBe(false)
        expect(qualifications({ ...base, createdAt: new Date(NaN) }, now).canClaim).toBe(false)
    })
    test('optional age and Discord checks can be disabled independently', () => {
        expect(qualifications({ ...base, minimumAccountAgeDays: 0, createdAt: null, requireDiscord: false, discordLinked: false }, now).canClaim).toBe(true)
        expect(qualifications({ ...base, discordLinked: false }, now).canClaim).toBe(false)
    })
    test('membership, publication, connection and the owner exclusion always apply', () => {
        for (const change of [{ currentRank: -1 }, { currentRank: 0 }, { currentRank: 255, maximumRank: 255 }, { enabled: false }, { connected: false }]) {
            expect(qualifications({ ...base, ...change }, now).canClaim).toBe(false)
        }
    })
    test('assignment alone does not confirm a replacement', () => {
        expect(confirmedRoles(['old'], 'new', ['old'])).toBe(false)
        expect(confirmedRoles(['old', 'new'], 'new', ['old'])).toBe(false)
        expect(confirmedRoles(['member', 'new'], 'new', ['old'])).toBe(true)
    })
    test('creation time must come from the matching authenticated Roblox account', () => {
        expect(creationDate({ sub: '7', created_at: 1_600_000_000 }, 7)?.getTime()).toBe(1_600_000_000_000)
        for (const profile of [{ sub: '8', created_at: 1_600_000_000 }, { sub: '7', created_at: '2020-01-01' }, { sub: '7', created_at: -1 }, { sub: '7', created_at: Infinity }, { sub: '7', created_at: Date.now() }]) {
            expect(creationDate(profile, 7)).toBeNull()
        }
    })
})
