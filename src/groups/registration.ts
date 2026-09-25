/** Only an elevated site admin can register a group they do not own. */
export function canRegisterGroup(elevated: boolean, userRobloxId: number, ownerId: number | null, rank?: number): boolean {
    return elevated || (rank !== undefined && rank >= 255) || ownerId === userRobloxId
}
