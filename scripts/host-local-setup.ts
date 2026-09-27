import { readFile, writeFile } from 'node:fs/promises'
import postgres from 'postgres'
const sql = postgres(
    'postgresql://trptools:trptools@localhost:55432/trptools',
    { prepare: false },
)
const token = (await readFile('/tmp/trptools-host-seed.log', 'utf8')).match(
    /access_token=([^\s]+)/,
)?.[1]
if (!token) throw new Error('Seed cookie not found')
const [group] = await sql`select id, slug from groups limit 1`
const origin = 'http://localhost:53001'
async function request(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(origin + path, {
        method,
        headers: {
            cookie: `access_token=${token}`,
            'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`)
    return text.startsWith('{') || text.startsWith('[')
        ? JSON.parse(text)
        : text
}
const existing = await request('/schedule?groupId=' + group!.id)
const start = new Date(Date.now() + 4 * 60000).toISOString()
const created = await request('/schedule', 'POST', {
    groupId: group!.id,
    name: 'Sunday afternoon service',
    description: 'Main Island and Cat Island service · joint dispatch shift',
    color: '#4287f5',
    startTime: start,
    rrule: 'FREQ=DAILY',
    duration: 90,
    visibility: 'PUBLIC',
    hostLevel: 2,
})
const room = await request('/rooms', 'POST', created)
await writeFile(
    '/tmp/trptools-host-fixture.json',
    JSON.stringify({
        token,
        groupId: group!.id,
        groupSlug: group!.slug,
        eventId: created.eventId,
        roomId: room.roomId,
        start,
    }),
    { mode: 0o600 },
)
console.log(
    JSON.stringify({
        groupSlug: group!.slug,
        eventId: created.eventId,
        roomId: room.roomId,
    }),
)
await sql.end()
