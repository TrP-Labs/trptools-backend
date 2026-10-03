import { expect, test } from 'bun:test'
import { demandDecision, votingAllowed, voteWindow } from './onDemand'
const start = new Date('2026-10-10T18:00:00Z')
const window = voteWindow(start, 120, 60)
const row = { ...window, onDemand: true, decision: 'PENDING', minimumRank: 50, voteRequireDiscord: true, websiteVoting: true }
test('demand is undecided until the exact cutoff and includes the threshold', () => {
    expect(demandDecision(true, 10, 10, window.decisionAt, new Date('2026-10-10T16:59:59Z'))).toBe('PENDING')
    expect(demandDecision(true, 10, 10, window.decisionAt, window.decisionAt)).toBe('CONFIRMED')
    expect(demandDecision(true, 9, 10, window.decisionAt, window.decisionAt)).toBe('FAILED')
    expect(demandDecision(false, 0, 10, window.decisionAt, window.decisionAt)).toBe('SCHEDULED')
})
test('public votes check inclusive minimum rank, Discord requirement, surface and clock', () => {
    const now = new Date('2026-10-10T16:30:00Z')
    expect(votingAllowed(row, 50, true, true, now)).toBe(true)
    expect(votingAllowed(row, 49, true, true, now)).toBe(false)
    expect(votingAllowed(row, 50, false, true, now)).toBe(false)
    expect(votingAllowed(row, 50, true, true, window.decisionAt)).toBe(false)
    expect(votingAllowed(row, 50, true, true, new Date('2026-10-10T15:59:59Z'))).toBe(false)
    expect(votingAllowed({ ...row, websiteVoting: false }, 50, true, true, now)).toBe(false)
    expect(votingAllowed({ ...row, websiteVoting: false }, 50, true, false, now)).toBe(true)
    expect(votingAllowed({ ...row, minimumRank: 0, voteRequireDiscord: false }, -1, false, true, now)).toBe(true)
})
