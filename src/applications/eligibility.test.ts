import { describe, expect, test } from 'bun:test'
import {
    blockedBy,
    cooldownEndsAt,
    decisionStands,
    outranksForm,
    type FormState,
    type LastSubmission
} from './eligibility'

const march = new Date('2026-03-01T00:00:00Z')
const june = new Date('2026-06-01T00:00:00Z')

const form = (overrides: Partial<FormState> = {}): FormState => ({
    open: true,
    hasRank: true,
    permaDeny: false,
    openedAt: march,
    denyCooldownDays: null,
    ...overrides
})

const denied = (overrides: Partial<LastSubmission> = {}): LastSubmission => ({
    status: 'DENIED',
    reviewedAt: march,
    clearedAt: null,
    ...overrides
})

describe('decisionStands', () => {
    test('a refusal from this intake still counts', () => {
        expect(decisionStands(denied({ reviewedAt: june }), form({ openedAt: march }))).toBe(true)
    })

    test('a refusal from a previous intake is let go when the form reopens', () => {
        expect(decisionStands(denied({ reviewedAt: march }), form({ openedAt: june }))).toBe(false)
    })

    test('perma-deny keeps a refusal across reopenings', () => {
        expect(decisionStands(denied({ reviewedAt: march }), form({ openedAt: june, permaDeny: true }))).toBe(true)
    })

    test('perma-deny does not keep an approval', () => {
        const approved: LastSubmission = { status: 'APPROVED', reviewedAt: march, clearedAt: null }
        expect(decisionStands(approved, form({ openedAt: june, permaDeny: true }))).toBe(false)
    })

    test('a cleared record never counts, perma-deny included', () => {
        expect(decisionStands(denied({ clearedAt: june }), form({ permaDeny: true }))).toBe(false)
    })

    test('an application still waiting always counts', () => {
        const pending: LastSubmission = { status: 'PENDING', reviewedAt: null, clearedAt: null }
        expect(decisionStands(pending, form({ openedAt: june }))).toBe(true)
    })
})

describe('a refusal with a cooldown', () => {
    const cooling = form({ openedAt: march, denyCooldownDays: 30 })
    const refused = denied({ reviewedAt: march })

    test('still counts inside the cooldown', () => {
        expect(decisionStands(refused, cooling, new Date('2026-03-20T00:00:00Z'))).toBe(true)
    })

    test('lapses once the cooldown is up, without the form closing', () => {
        expect(decisionStands(refused, cooling, new Date('2026-04-02T00:00:00Z'))).toBe(false)
    })

    test('is permanent again under perma-deny, cooldown or not', () => {
        const permanent = form({ openedAt: march, denyCooldownDays: 30, permaDeny: true })
        expect(decisionStands(refused, permanent, new Date('2027-01-01T00:00:00Z'))).toBe(true)
        expect(cooldownEndsAt(refused, permanent)).toBeNull()
    })

    test('never applies to an approval', () => {
        const approved: LastSubmission = { status: 'APPROVED', reviewedAt: march, clearedAt: null }
        expect(cooldownEndsAt(approved, cooling)).toBeNull()
    })

    test('reports when it lapses, so the applicant can be told', () => {
        expect(cooldownEndsAt(refused, cooling)).toEqual(new Date('2026-03-31T00:00:00Z'))
    })

    test('no cooldown means it lasts the whole intake', () => {
        expect(cooldownEndsAt(refused, form({ denyCooldownDays: null }))).toBeNull()
        expect(decisionStands(refused, form({ denyCooldownDays: null }), new Date('2027-01-01T00:00:00Z'))).toBe(true)
    })
})

describe('outranksForm', () => {
    test('somebody above the rank on offer outranks it', () => {
        expect(outranksForm(254, 1)).toBe(true)
    })

    test('holding the rank itself does not', () => {
        expect(outranksForm(1, 1)).toBe(false)
    })

    test('a non-member never outranks anything', () => {
        expect(outranksForm(-1, 0)).toBe(false)
    })

    test('a form with no rank bound has nothing to outrank', () => {
        expect(outranksForm(255, null)).toBe(false)
    })
})

describe('blockedBy', () => {
    test('a closed form turns everybody away, whatever else is true', () => {
        expect(blockedBy(form({ open: false }), denied(), 254, 1)).toBe('CLOSED')
    })

    test('a form whose rank binding has gone is closed', () => {
        expect(blockedBy(form({ hasRank: false }), null, -1, null)).toBe('CLOSED')
    })

    test('rank is checked before a standing decision, so the real reason shows', () => {
        expect(blockedBy(form(), denied(), 254, 1)).toBe('RANK_TOO_HIGH')
    })

    test('a decision that still stands is reported as itself', () => {
        expect(blockedBy(form(), denied(), -1, 1)).toBe('DENIED')
        expect(blockedBy(form(), { status: 'APPROVED', reviewedAt: march, clearedAt: null }, -1, 1)).toBe('APPROVED')
    })

    test('nothing blocks a first-time applicant on an open form', () => {
        expect(blockedBy(form(), null, -1, 1)).toBeNull()
    })

    test('reopening lets a previously refused applicant back in', () => {
        expect(blockedBy(form({ openedAt: june }), denied({ reviewedAt: march }), -1, 1)).toBeNull()
    })
})
