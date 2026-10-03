import { expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { HostModel } from '../src/host/model'
import { DEFAULT_SCHEDULE, makeTimeline } from '../src/host/rules'

const source = await Bun.file(new URL('../src/host/controller.ts', import.meta.url)).text()
const snapshot: HostModel.Snapshot = {
    roomId: 'room', revision:0, groupId: 'group', eventId: 'event', eventName: 'Shift', occurrence: new Date(0).toISOString(),
    botConnected: true, endsAt: 3600000, activeUntil: 5400000, timeline: makeTimeline(DEFAULT_SCHEDULE, 0, 3600000),
    note: '', ownerRobloxId: null, imageUrl: null, joinCode: null, announceJoinCode: null, defaultAnnounceJoinCode: true,
}

function emittedController(legacy = false) {
    // The controller uses JavaScript syntax. Preserve its multiline callbacks
    // instead of letting Bun collapse them: Elysia's Promise inference depends
    // on function.toString() and must survive either emitted build shape.
    const emitted = (legacy ? source.replaceAll('async (', '(') : source)
        .replace(/^import .*\n/gm, '').replace('export const host', 'const host')
    const commits: string[] = []
    const service = Object.fromEntries(['schedule', 'saveSchedule', 'get', 'extend', 'event', 'note', 'upload'].map(name => [name,
        async () => { await Promise.resolve(); commits.push(name); return name === 'schedule' ? DEFAULT_SCHEDULE : name === 'saveSchedule' ? 'Success' : snapshot },
    ]))
    const plugin = new Function('Elysia', 't', 'sessionPlugin', 'HostModel', 'Host', `${emitted}\nreturn host`)(
        Elysia, t, new Elysia().derive(() => ({ session: {} })), HostModel, service,
    ) as Elysia
    const failures: string[] = []
    const app = new Elysia().onError(({ code, error, set }) => {
        failures.push((error as {type?:string}).type ?? String(code))
        set.status = 400
        return 'Bad Request'
    }).use(plugin)
    return { app, commits, failures }
}

const mutations = [
    ['/host/room/extend', 'POST', {minutes:5}, 'extend'],
    ['/host/room/events/edit', 'POST', {operation:'ACKNOWLEDGE'}, 'event'],
    ['/host/room/events/public', 'POST', {operation:'ACTIVATE'}, 'event'],
    ['/host/room/events/edit', 'POST', {operation:'RESCHEDULE',reference:'END',offsetMinutes:-20}, 'event'],
    ['/host/room/note', 'PUT', {note:'Update',ownerRobloxId:null,joinCode:'CODE123',announceJoinCode:false}, 'note'],
] as const

test('reproduces a committed mutation followed by Bad Request with the legacy emitted handlers', async () => {
    const {app,commits,failures} = emittedController(true)
    const response = await app.handle(new Request('http://localhost/host/room/extend', {
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minutes:5}),
    }))
    await Promise.resolve()
    expect(commits).toEqual(['extend'])
    expect(response.status).toBe(400)
    expect(failures).toEqual(['response'])
})

test('all emitted host mutation handlers await success before validating the response', async () => {
    const {app,commits,failures} = emittedController()
    for (const [path,method,body,name] of mutations) {
        const response = await app.handle(new Request('http://localhost'+path, {
            method,headers:{'content-type':'application/json'},body:JSON.stringify(body),
        }))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(snapshot)
        expect(commits.at(-1)).toBe(name)
    }
    expect(failures).toEqual([])
})
