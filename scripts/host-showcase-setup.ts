import { readFile, writeFile } from 'node:fs/promises'
import Redis from 'ioredis'
import { createHash, randomBytes } from 'node:crypto'
import { permissionsForLevel } from '../src/utils/permissions'
import postgres from 'postgres'
import { DEFAULT_SCHEDULE, makeTimeline } from '../src/host/rules'
const fixture = JSON.parse(
    await readFile('/tmp/trptools-host-fixture.json', 'utf8'),
)
const redis = new Redis('redis://localhost:56379'),
    sql = postgres('postgresql://trptools:trptools@localhost:55432/trptools', {
        prepare: false,
    })
// Only the scratch fixture created by host-local-setup is touched here.
const token = randomBytes(24).toString('hex')
const [host] =
    await sql`insert into users(roblox_id,cached_username,cached_display_name,cached_at,theme) values(${910000000 + Math.floor(Math.random() * 1000000)},'RiverHost','River',now(),'dim') returning id`
await sql`insert into sessions(session_id,user_id,expires_at) values(${createHash('sha256').update(token).digest('hex')},${host!.id},now()+interval '1 day')`
await redis.set(
    `perm:${fixture.groupId}:${host!.id}`,
    `2:100:${permissionsForLevel(2)}:`,
    'EX',
    3600,
)
fixture.showcaseToken = token
const start = Date.now() - 20 * 60000 - 35000,
    end = start + 60 * 60000
const custom = {
    id: 'radio-check',
    label: 'Radio check and service update',
    action: 'REMINDER' as const,
    reference: 'START' as const,
    offsetMinutes: 21,
    audience: 'ALL' as const,
    optional: false,
    automation: false,
}
const schedule = {
    ...DEFAULT_SCHEDULE,
    entries: [
        ...DEFAULT_SCHEDULE.entries,
        {
            id: 'preflight',
            label: 'Confirm server and dispatcher cover',
            action: 'REMINDER',
            reference: 'START',
            offsetMinutes: -8,
            audience: 'HOST',
            optional: false,
            automation: false,
        },
        custom,
    ],
}
await sql`update groups set name='Demo Transit',cached_icon=null,cached_at=now(),host_schedule=${sql.json(schedule)} where id=${fixture.groupId}`
await sql`insert into bot_configs(group_id,guild_id,cached_guild_name,owner_roblox_id,auto_complete,auto_staff_start,auto_begin) values(${fixture.groupId},'111111111111111111','Demo Transit staff','123456',true,true,true) on conflict(group_id) do update set auto_complete=true,auto_staff_start=true,auto_begin=true`
const timeline = makeTimeline(schedule, start, end, {
    STAFF_START: true,
    BEGIN: true,
    COMPLETE: true,
})
for (const item of timeline) {
    if (item.id === 'staff') item.status = 'AUTOMATED'
    if (item.id === 'edit') item.status = 'SKIPPED'
    if (item.id === 'public') item.status = 'ACTIVATED'
}
await redis.hset('room:' + fixture.roomId, {
    startAt: String(start),
    expiresAt: String(end),
    activeUntil: String(end + 1800000),
    occurrence: new Date(start).toISOString(),
    botConnected: 'true',
    timeline: JSON.stringify(timeline),
    note: 'Main Island and Cat Island services are open. Dispatchers should send drivers back to their depot before the end.',
    ownerRobloxId: '123456',
})
await sql`update events set start_time=${new Date(start)},duration=60 where event_id=${fixture.eventId}`
fixture.start = new Date(start).toISOString()
await writeFile('/tmp/trptools-host-fixture.json', JSON.stringify(fixture), {
    mode: 0o600,
})
await redis.hdel('room:' + fixture.roomId, 'needsRefresh', 'refreshLease')
await redis.del('dispatchroom:' + fixture.roomId + ':users')
await writeFile(
    '/tmp/trptools-host-showcase.json',
    JSON.stringify({ start, end }),
)
redis.disconnect()
await sql.end()
console.log('Showcase room prepared in isolated test stack')
