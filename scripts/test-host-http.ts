import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import Redis from 'ioredis'
import postgres from 'postgres'
const fixture = JSON.parse(
    await readFile('/tmp/trptools-host-fixture.json', 'utf8'),
)
const redis = new Redis('redis://localhost:56379')
const sql = postgres(
    'postgresql://trptools:trptools@localhost:55432/trptools',
    { prepare: false },
)
const results: unknown[] = []
const actors: Record<
    string,
    { token: string; id: string; permissions: number }
> = {}
for (const [name, permissions] of Object.entries({
    host: 5,
    dispatcher: 3,
    nobody: 1,
})) {
    const token = randomBytes(24).toString('hex')
    const [user] =
        await sql`insert into users (roblox_id,cached_username,cached_display_name,cached_at) values (${900000000 + Math.floor(Math.random() * 10000000)},${name},${name},now()) returning id`
    await sql`insert into sessions(session_id,user_id,expires_at) values (${createHash('sha256').update(token).digest('hex')},${user!.id},now()+interval '1 day')`
    actors[name] = { token, id: user!.id, permissions }
}
try {
    for (const origin of ['http://localhost:53001', 'http://localhost:53002']) {
        for (const actor of Object.values(actors))
            await redis.set(
                `perm:${fixture.groupId}:${actor.id}`,
                `2:100:${actor.permissions}:`,
                'EX',
                60,
            )
        async function call(
            path: string,
            method = 'GET',
            body?: unknown,
            token = fixture.token,
        ) {
            const response = await fetch(origin + path, {
                method,
                headers: {
                    cookie: `access_token=${token}`,
                    'content-type': 'application/json',
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
            const text = await response.text()
            let value: any
            try {
                value = JSON.parse(text)
            } catch {
                value = text
            }
            return { status: response.status, value }
        }
        const state = await call('/host/' + fixture.roomId)
        console.log(
            origin,
            state.status,
            typeof state.value === 'object'
                ? state.value.timeline?.length
                : state.value,
        )
        assert.equal(state.status, 200)
        const event = (
            await sql`select duration from events where event_id=${fixture.eventId}`
        )[0]
        const oldEnd = state.value.endsAt
        const [first, second] = await Promise.all([
            call('/host/' + fixture.roomId + '/extend', 'POST', { minutes: 5 }),
            call('/host/' + fixture.roomId + '/extend', 'POST', {
                minutes: 10,
            }),
        ])
        assert.equal(first.status, 200)
        assert.equal(second.status, 200)
        const extended = await call('/host/' + fixture.roomId)
        assert.equal(extended.value.endsAt, oldEnd + 900000)
        assert.equal(
            (
                await sql`select duration from events where event_id=${fixture.eventId}`
            )[0]!.duration,
            event!.duration,
        )
        assert.equal(
            (
                await call('/host/' + fixture.roomId + '/extend', 'POST', {
                    minutes: 6,
                })
            ).status,
            400,
        )
        assert.equal(
            (
                await call('/host/' + fixture.roomId + '/note', 'PUT', {
                    note: 'Main Island services are open. Please return to your depot before the end.',
                    ownerRobloxId: '123456',
                })
            ).status,
            200,
        )
        assert.equal(
            (await call('/host/' + fixture.roomId)).value.note.startsWith(
                'Main Island',
            ),
            true,
        )
        assert.equal(
            (await call('/host/' + fixture.roomId, 'GET', undefined, 'invalid'))
                .status,
            401,
        )
        const unauthorized = await fetch(origin + '/bot/internal/due/lease')
        assert.equal(unauthorized.status, 401)
        const host = actors.host!.token,
            dispatcher = actors.dispatcher!.token,
            nobody = actors.nobody!.token
        assert.equal(
            (await call('/host/' + fixture.roomId, 'GET', undefined, host))
                .status,
            200,
        )
        assert.equal(
            (
                await call(
                    '/host/' + fixture.roomId,
                    'GET',
                    undefined,
                    dispatcher,
                )
            ).status,
            200,
        )
        assert.equal(
            (await call('/host/' + fixture.roomId, 'GET', undefined, nobody))
                .status,
            403,
        )
        assert.equal(
            (await call('/rooms/' + fixture.roomId, 'DELETE', undefined, host))
                .status,
            403,
        )
        assert.equal(
            (
                await call(
                    '/host/' + fixture.roomId + '/extend',
                    'POST',
                    { minutes: 5 },
                    dispatcher,
                )
            ).status,
            403,
        )
        assert.equal(
            (
                await call(
                    '/host/' + fixture.roomId + '/note',
                    'PUT',
                    { note: 'forbidden', ownerRobloxId: null },
                    dispatcher,
                )
            ).status,
            403,
        )
        assert.equal(
            (
                await call(
                    '/dispatch/' + fixture.roomId + '/solve',
                    'POST',
                    {},
                    host,
                )
            ).status,
            403,
        )
        assert.equal(
            (
                await call(
                    '/host/' + fixture.roomId + '/events/return-depot',
                    'POST',
                    {
                        operation: 'RESCHEDULE',
                        reference: 'END',
                        offsetMinutes: -10,
                    },
                    dispatcher,
                )
            ).status,
            403,
        )
        results.push({
            permissionBoundaries: true,
            origin,
            concurrentExtensions: true,
            recurringShiftUnchanged: true,
            noteEdit: true,
            unauthorizedRefused: true,
        })
    }
    await writeFile(
        '/tmp/trptools-host-http-results.json',
        JSON.stringify(results, null, 2),
    )
    console.log('Docker and workerd host HTTP checks passed')
} finally {
    for (const actor of Object.values(actors)) {
        await sql`delete from users where id=${actor.id}`
        await redis.del(`perm:${fixture.groupId}:${actor.id}`)
    }
    redis.disconnect()
    await sql.end()
}
