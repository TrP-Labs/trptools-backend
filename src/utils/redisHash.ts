/** Upstash returns flat HGETALL pairs when automatic deserialization is off. */
export function redisHash(value: unknown): Record<string, string> {
    if (Array.isArray(value)) {
        const hash: Record<string, string> = {}
        for (let index = 0; index + 1 < value.length; index += 2) {
            if (typeof value[index] === 'string') hash[value[index]] = String(value[index + 1])
        }
        return hash
    }

    return value && typeof value === 'object' ? value as Record<string, string> : {}
}

/** Only hash replies need normalization; write counts and script arrays stay intact. */
export function pipelineResult(value: unknown, error: string | undefined, hash: boolean): [Error | null, unknown] {
    return [error ? new Error(error) : null, hash ? redisHash(value) : value]
}
