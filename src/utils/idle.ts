import { dataRedis } from './redis'

/**
 * What lets the minute jobs leave Postgres alone while nobody is around.
 *
 * The scheduler, the push reminders and the statistics fold each ran a query
 * every minute whether or not anything had changed, which kept a Neon compute
 * awake around the clock for an empty site. Each now asks Redis first and
 * reaches Postgres only when there is work: a memo of what it last read,
 * forgotten by the writes that could change it, or a flag a visitor raised.
 *
 * A memo carries a version. Whoever changes the underlying rows bumps it, and
 * a reader only stores what it loaded if the version is still the one it saw
 * before loading — otherwise an edit landing mid-read would be overwritten by
 * the stale result and stay hidden until the memo expired.
 */

export type Memo = 'scheduler' | 'notifications'

const valueKey = (name: Memo) => `memo:${name}`
const versionKey = (name: Memo) => `memo:${name}:version`

const READ = `return {redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or '0'}`
const WRITE = `
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`
const FORGET = `
for i = 1, #KEYS, 2 do
    redis.call('INCR', KEYS[i + 1])
    redis.call('DEL', KEYS[i])
end
return 1
`

/** The stored value (null when there is none) and the version to write back against. */
export async function readMemo(name: Memo): Promise<{ value: string | null; version: string }> {
    const [value, version] = await dataRedis.eval<[string, string]>(READ, [valueKey(name), versionKey(name)], [])
    return { value: value ? value : null, version: String(version ?? '0') }
}

export async function writeMemo(name: Memo, version: string, value: string, ttlSeconds: number) {
    await dataRedis.eval(WRITE, [valueKey(name), versionKey(name)], [version, value, String(Math.max(1, Math.ceil(ttlSeconds)))])
}

/**
 * Called by every write that could change what a memo holds. Never throws:
 * a failed invalidation is a stale memo, and the write itself has succeeded.
 */
export async function forget(...names: Memo[]) {
    await dataRedis.eval(FORGET, names.flatMap((name) => [valueKey(name), versionKey(name)]), [])
        .catch((error: unknown) => console.warn('[idle] memo invalidation failed', error instanceof Error ? error.message : 'unknown'))
}

/** Shifts, their groups and their bot settings: both minute jobs read them. */
export const scheduleChanged = () => forget('scheduler', 'notifications')

const STATISTICS_PENDING = 'statistics:pending'
const TAKE = `local value = redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return value`

/** A page view was recorded; the next fold has something to do. */
export async function markStatisticsPending() {
    await dataRedis.set(STATISTICS_PENDING, '1').catch(() => undefined)
}

/** Takes the flag, so concurrent folds do not both run on one view. */
export async function takeStatisticsPending(): Promise<boolean> {
    return Boolean(await dataRedis.eval<string | null>(TAKE, [STATISTICS_PENDING], []))
}

/** At most once an hour, and only on a run that is already doing work. */
export async function hourlyOnce(job: string): Promise<boolean> {
    return Boolean(await dataRedis.set(`cleanup:${job}`, '1', 'EX', 3600, 'NX'))
}
