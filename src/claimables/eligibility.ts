export function qualifications(input: {
    enabled: boolean; connected: boolean; currentRank: number | null; maximumRank: number;
    minimumAccountAgeDays: number; createdAt: Date | null; requireDiscord: boolean; discordLinked: boolean
}, now = Date.now()) {
    const accountAgeDays = input.createdAt && Number.isFinite(input.createdAt.getTime())
        ? Math.max(0, Math.floor((now - input.createdAt.getTime()) / 86_400_000)) : null
    const member = input.currentRank === null ? null : input.currentRank > 0
    const rank = input.currentRank === null ? null : input.currentRank <= input.maximumRank && input.currentRank < 255
    const age = input.minimumAccountAgeDays === 0 ? true : accountAgeDays === null ? null : accountAgeDays >= input.minimumAccountAgeDays
    const discord = !input.requireDiscord || input.discordLinked
    return { member, rank, age, discord, accountAgeDays,
        canClaim: input.enabled && input.connected && member === true && rank === true && age === true && discord }
}

export function confirmedRoles(roles: string[], target: string, removed: string[]) {
    return roles.includes(target) && removed.every(role => !roles.includes(role))
}
