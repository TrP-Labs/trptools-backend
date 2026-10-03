/** The vote closes once, before preparation; later withdrawals cannot undo a decision. */
export function voteWindow(start: Date, openLead: number, decisionLead: number) {
    return { voteOpensAt: new Date(start.getTime() - openLead * 60_000), decisionAt: new Date(start.getTime() - decisionLead * 60_000) }
}
export function demandDecision(onDemand: boolean, count: number, minimum: number, decisionAt: Date, now = new Date()) {
    if (!onDemand) return 'SCHEDULED'
    if (now < decisionAt) return 'PENDING'
    return count >= minimum ? 'CONFIRMED' : 'FAILED'
}
export function votingAllowed(row: { onDemand: boolean; decision: string; voteOpensAt: Date; decisionAt: Date; minimumRank: number; voteRequireDiscord: boolean; websiteVoting: boolean }, rank: number, discord: boolean, website: boolean, now = new Date()) {
    return row.onDemand && row.decision === 'PENDING' && now >= row.voteOpensAt && now < row.decisionAt &&
        (row.minimumRank === 0 || rank >= row.minimumRank) && (!row.voteRequireDiscord || discord) && (!website || row.websiteVoting)
}
