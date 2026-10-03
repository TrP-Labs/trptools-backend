import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis'
import {
    CHANGE_EVENT,
    CLAIM_TIMELINE,
    EXTEND_HOST,
    FINISH_TIMELINE,
    READ_HOST,
    SET_NOTE,
    STAFF_ACTION,
} from '../src/host/redisScripts'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import { HostModel } from '../src/host/model'
import { CREATE_ROOM, TOUCH_ROOM } from '../src/rooms/lifecycle'
import { makeTimeline, DEFAULT_SCHEDULE } from '../src/host/rules'
const directory = await mkdtemp(join(tmpdir(), 'trptools-host-redis-'))
const socket = join(directory, 'redis.sock')
const processRedis = Bun.spawn(
    [
        'redis-server',
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--unixsocketperm',
        '700',
        '--save',
        '',
        '--appendonly',
        'no',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
)
const redis = new Redis(socket, { retryStrategy: () => 20 })
redis.on('error', () => {})
await redis.ping()
const start = Date.parse('2026-09-27T12:00:00.000Z'),
    end = start + 3600000
let now = start - 600000
const key = 'room:test',
    channel = 'dispatchroom.test'
async function run(script: string, keys = [key], args: string[] = []) {
    return redis.eval(
        script,
        keys.length,
        ...keys,
        String(now),
        'test',
        channel,
        ...args,
    ) as Promise<string>
}
async function snapshot() {
    return JSON.parse(await run(READ_HOST))
}
beforeEach(async () => {
    // This socket is unique to the Redis child created above; never use a shared database.
    await redis.del(
        key,
        'groupindex:group',
        'dispatchroom:test:users',
        'shiftnote:event:' + start,
    )
    now = start - 600000
    await redis.hset(key, {
        groupId: 'group',
        eventId: 'event',
        eventName: 'Shift',
        creatorId: 'host',
        createdAt: String(now),
        occurrence: new Date(start).toISOString(),
        startAt: String(start),
        expiresAt: String(end),
        activeUntil: String(end + 1800000),
        timeline: JSON.stringify(
            makeTimeline(DEFAULT_SCHEDULE, start, end, {
                BEGIN: true,
                STAFF_START: true,
                COMPLETE: true,
            }),
        ),
    })
    await redis.set('groupindex:group', 'test')
})
afterAll(async () => {
    redis.disconnect()
    processRedis.kill()
    await processRedis.exited
    await rm(directory, { recursive: true, force: true })
})
test('only one concurrent opener wins and room is written with its group index', async () => {
    await redis.del(key, 'groupindex:group')
    const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
            redis.eval(
                CREATE_ROOM,
                2,
                `room:${i}`,
                'groupindex:group',
                String(i),
                JSON.stringify({ groupId: 'group' }),
                '7200',
            ),
        ),
    )
    expect(attempts.filter((v) => v === 1)).toHaveLength(1)
    expect(
        await redis.exists(`room:${await redis.get('groupindex:group')}`),
    ).toBe(1)
})
test('empty timelines and idle polls encode arrays', async () => {
    await redis.hset(key, 'timeline', '[]')
    expect((await snapshot()).timeline).toEqual([])
    expect(JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))).toEqual([])
})
test('concurrent extensions accumulate and move only pending end events', async () => {
    await Promise.all([
        run(EXTEND_HOST, [key, 'groupindex:group'], ['5']),
        run(EXTEND_HOST, [key, 'groupindex:group'], ['10']),
    ])
    const state = await snapshot()
    expect(state.endsAt).toBe(end + 900000)
    expect(state.activeUntil).toBe(end + 2700000)
    expect(state.timeline.find((i: any) => i.id === 'complete').dueAt).toBe(
        end + 1200000,
    )
    expect(state.timeline.find((i: any) => i.id === 'public').dueAt).toBe(start)
})
test('skip and acknowledgment prevent automated delivery', async () => {
    await run(CHANGE_EVENT, [key], ['staff', 'SKIP', 'HOST', '', '0', 'host'])
    await run(
        CHANGE_EVENT,
        [key],
        ['public', 'ACKNOWLEDGE', 'HOST', '', '0', 'host'],
    )
    now = start
    expect(JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))).toEqual([])
    const states = (await snapshot()).timeline
    expect(states.find((i: any) => i.id === 'staff').status).toBe('SKIPPED')
    expect(states.find((i: any) => i.id === 'public').status).toBe(
        'ACKNOWLEDGED',
    )
})
test('dispatch can acknowledge only an active dispatch reminder', async () => {
    now = end - 600000
    await run(CLAIM_TIMELINE, [key], ['READ'])
    expect(
        await run(
            CHANGE_EVENT,
            [key],
            ['return-depot', 'SKIP', 'DISPATCH', '', '0', 'dispatcher'],
        ),
    ).toBe('FORBIDDEN')
    const state = JSON.parse(
        await run(
            CHANGE_EVENT,
            [key],
            ['return-depot', 'ACKNOWLEDGE', 'DISPATCH', '', '0', 'dispatcher'],
        ),
    )
    expect(
        state.timeline.find((i: any) => i.id === 'return-depot').status,
    ).toBe('ACKNOWLEDGED')
})
test('automation leases retry failures and reflect completed delivery', async () => {
    let actions = JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))
    expect(actions[0].timelineId).toBe('staff')
    expect(JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))).toEqual([])
    await run(FINISH_TIMELINE, [key], ['staff', 'RELEASE'])
    expect(JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))).toHaveLength(
        1,
    )
    await run(FINISH_TIMELINE, [key], ['staff', 'COMPLETE'])
    expect((await snapshot()).timeline[0].status).toBe('AUTOMATED')
})
test('manual early activation retains its time and source after delivery', async () => {
    await run(
        CHANGE_EVENT,
        [key],
        ['public', 'ACTIVATE', 'HOST', '', '0', 'host'],
    )
    const actions = JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))
    expect(actions.some((i: any) => i.timelineId === 'public')).toBe(true)
    await run(FINISH_TIMELINE, [key], ['public', 'COMPLETE'])
    const item = (await snapshot()).timeline.find((i: any) => i.id === 'public')
    expect(item.status).toBe('ACTIVATED')
    expect(item.dueAt).toBe(start)
})
test('unacknowledged reminders become ignored at the next distinct window', async () => {
    now = start - 300000
    await run(CLAIM_TIMELINE, [key], ['READ'])
    expect(
        (await snapshot()).timeline.find((i: any) => i.id === 'edit').status,
    ).toBe('READY')
    now = start
    await run(CLAIM_TIMELINE, [key], ['READ'])
    expect(
        (await snapshot()).timeline.find((i: any) => i.id === 'edit').status,
    ).toBe('IGNORED')
})
test('rescheduling changes one occurrence and rejects completed events', async () => {
    await run(
        CHANGE_EVENT,
        [key],
        ['edit', 'RESCHEDULE', 'HOST', 'END', '-20', 'host'],
    )
    expect(
        (await snapshot()).timeline.find((i: any) => i.id === 'edit').dueAt,
    ).toBe(end - 1200000)
    await run(
        CHANGE_EVENT,
        [key],
        ['edit', 'ACKNOWLEDGE', 'HOST', '', '0', 'host'],
    )
    expect(
        await run(
            CHANGE_EVENT,
            [key],
            ['edit', 'RESCHEDULE', 'HOST', 'START', '0', 'host'],
        ),
    ).toBe('CONFLICT')
})
test('refresh leases preserve newer edits and retry crashed delivery', async () => {
    const noteKey = 'shiftnote:event:' + start
    await run(
        SET_NOTE,
        [key, noteKey],
        [JSON.stringify({ note: 'First', ownerRobloxId: null })],
    )
    const actions = JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL']))
    const refresh = actions.find((i: any) => i.action === 'REFRESH')
    now += 1
    await run(
        SET_NOTE,
        [key, noteKey],
        [JSON.stringify({ note: 'Second', ownerRobloxId: '123' })],
    )
    await run(FINISH_TIMELINE, [key], [refresh.timelineId, 'COMPLETE'])
    expect(await redis.hget(key, 'needsRefresh')).not.toBeNull()
    now += 120001
    expect(
        JSON.parse(await run(CLAIM_TIMELINE, [key], ['POLL'])).some(
            (i: any) => i.action === 'REFRESH',
        ),
    ).toBe(true)
    expect(JSON.parse((await redis.get(noteKey))!).note).toBe('Second')
})
test('room stays live through wrap-up and while occupied, closing only when inactive and empty', async () => {
    now = end + 1799999
    expect(
        Number(await run(TOUCH_ROOM, [key, 'dispatchroom:test:users'])),
    ).toBe(1)
    now += 1
    await redis.hset('dispatchroom:test:users', 'host', '1')
    expect(
        Number(await run(TOUCH_ROOM, [key, 'dispatchroom:test:users'])),
    ).toBe(1)
    await redis.del('dispatchroom:test:users')
    expect(
        Number(await run(TOUCH_ROOM, [key, 'dispatchroom:test:users'])),
    ).toBe(0)
    expect(await redis.get('groupindex:group')).toBeNull()
})

test('an empty active room expires at wrap-up without needing a poller', async () => {
    await run(TOUCH_ROOM, [key, 'dispatchroom:test:users'])
    expect(await redis.ttl(key)).toBe((end + 1800000 - now) / 1000)
})
test('an early reminder remains visible and dismissible for dispatchers', async () => {
    const state = JSON.parse(
        await run(
            CHANGE_EVENT,
            [key],
            ['return-depot', 'ACTIVATE', 'HOST', '', '0', 'host'],
        ),
    )
    expect(
        state.timeline.find((i: any) => i.id === 'return-depot').awaitingAck,
    ).toBe(true)
    const dismissed = JSON.parse(
        await run(
            CHANGE_EVENT,
            [key],
            ['return-depot', 'ACKNOWLEDGE', 'DISPATCH', '', '0', 'dispatcher'],
        ),
    )
    expect(
        dismissed.timeline.find((i: any) => i.id === 'return-depot').status,
    ).toBe('ACKNOWLEDGED')
})

test('a same-millisecond edit cannot be consumed by an earlier refresh', async () => {
    const noteKey = 'shiftnote:event:' + start
    await run(SET_NOTE, [key,noteKey], [JSON.stringify({note:'First',ownerRobloxId:null})])
    const first = JSON.parse(await run(CLAIM_TIMELINE,[key],['POLL'])).find((item:any)=>item.action==='REFRESH')
    await run(SET_NOTE, [key,noteKey], [JSON.stringify({note:'Second',ownerRobloxId:null})])
    await run(FINISH_TIMELINE,[key],[first.timelineId,'COMPLETE'])
    expect(await redis.hget(key,'needsRefresh')).not.toBeNull()
    now += 120001
    expect(JSON.parse(await run(CLAIM_TIMELINE,[key],['POLL'])).some((item:any)=>item.action==='REFRESH')).toBe(true)
})

test('code edits, image uploads, extensions, and Discord commands share valid snapshots', async () => {
    const contract = TypeCompiler.Compile(HostModel.snapshot)
    const noteKey = 'shiftnote:event:' + start
    const saved = JSON.parse(await run(SET_NOTE,[key,noteKey],[JSON.stringify({note:'Staff code',ownerRobloxId:null,joinCode:'ABC123',announceJoinCode:false})]))
    expect(saved.joinCode).toBe('ABC123')
    expect(saved.announceJoinCode).toBe(false)
    expect(contract.Check(saved)).toBe(true)
    const uploaded = JSON.parse(await run(SET_NOTE,[key,noteKey],[JSON.stringify({note:'Staff code',ownerRobloxId:null,imageUrl:'https://example.test/image.png'})]))
    expect(uploaded.joinCode).toBe('ABC123')
    expect(uploaded.announceJoinCode).toBe(false)
    expect(contract.Check(uploaded)).toBe(true)
    const staff = JSON.parse(await run(STAFF_ACTION,[key],['event',new Date(start).toISOString(),'BEGIN']))
    expect(staff.timeline.find((item:any)=>item.action==='BEGIN').status).toBe('ACTIVATED')
    expect(contract.Check(staff)).toBe(true)
    const cleared = JSON.parse(await run(SET_NOTE,[key,noteKey],[JSON.stringify({note:'',ownerRobloxId:null,joinCode:null,announceJoinCode:null})]))
    expect(cleared.joinCode).toBeNull()
    expect(cleared.announceJoinCode).toBeNull()
})

test('seeded fuzz preserves the response contract across 1500 timeline operations', async () => {
    const contract = TypeCompiler.Compile(HostModel.snapshot)
    let seed = 0x53484946
    const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296 }
    const ids = ['staff','edit','public','return-depot','complete']
    const operations = ['ACTIVATE','ACKNOWLEDGE','SKIP','RESCHEDULE']
    for(let i=0;i<1500;i++) {
        if(i%50===0) await redis.hset(key,'timeline',JSON.stringify(makeTimeline(DEFAULT_SCHEDULE,start,end,{BEGIN:true,STAFF_START:true,COMPLETE:true})))
        now = start - 600000 + Math.floor(random()*5400000)
        const pick = Math.floor(random()*6)
        let raw:string
        if(pick===0) raw = await run(EXTEND_HOST,[key,'groupindex:group'],[String([5,10,30,60][Math.floor(random()*4)])])
        else if(pick===1) raw = await run(SET_NOTE,[key,'shiftnote:event:'+start],[JSON.stringify({note:i%2?'🚎'.repeat(200):'<script>not HTML</script>',ownerRobloxId:i%3?'123':null,joinCode:i%4?'TEST123':null,announceJoinCode:i%3===0?null:i%2===0})])
        else if(pick===2) { await run(CLAIM_TIMELINE,[key],[random()<0.5?'READ':'POLL']); raw = await run(READ_HOST) }
        else if(pick===3) raw = await run(STAFF_ACTION,[key],['event',new Date(start).toISOString(),['BEGIN','STAFF_START','COMPLETE'][Math.floor(random()*3)]!])
        else if(pick===4) raw = await run(FINISH_TIMELINE,[key],[ids[Math.floor(random()*ids.length)]!,random()<0.5?'RELEASE':'COMPLETE'])
        else raw = await run(CHANGE_EVENT,[key],[ids[Math.floor(random()*ids.length)]!,operations[Math.floor(random()*operations.length)]!,random()<0.5?'HOST':'DISPATCH',random()<0.5?'START':'END',String(Math.floor(random()*2881)-1440),'actor'])
        if(['CONFLICT','FORBIDDEN','NOT_FOUND'].includes(raw)) continue
        const value = JSON.parse(raw)
        if(!contract.Check(value)) throw new Error(JSON.stringify([...contract.Errors(value)]))
        expect(value.timeline.every((item:any,index:number)=>index===0||item.dueAt>=value.timeline[index-1].dueAt)).toBe(true)
    }
})
