/** The database trigger is the last guard when concurrent creates pass an API count check. */
export function databaseLimitReached(error: unknown, message: string): boolean {
    let current = error
    for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
        const failure = current as { message?: unknown; cause?: unknown }
        if (typeof failure.message === 'string' && failure.message.includes(message)) return true
        current = failure.cause
    }
    return false
}
