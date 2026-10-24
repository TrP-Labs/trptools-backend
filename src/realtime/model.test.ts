import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { RealtimeModel } from './model'
import { GAME_JOBS, isGameJob } from './rules'

// Exercise Elysia's HTTP decoder: a field that TypeBox accepts but strips
// before the handler is just as lost as a field refused at the door.
const app = new Elysia().post('/feed', ({ body }) => body, { body: RealtimeModel.report })

for (const Job of [...GAME_JOBS, undefined, 'FutureJob']) {
    test(`accepts and preserves a report with Job=${Job}`, async () => {
        const payload = {
            Users: [{ Username: 'Meow', ID: 67, ...(Job ? { Job } : {}), Position: { X: 1520.4, Y: 12.1, Z: -340 } }, { ID: 68 }],
            Vehicles: [{ Name: 'ZiU-682 (ZiU-9)', Id: 12, OwnerId: 67, Route: '6', AssignedRoute: '10', TabletEquipped: true }],
            ServerData: { runtime: 3725, gametime: 845, routes: ['6', '9', '10', '14', '16'] }
        }
        const response = await app.handle(new Request('http://localhost/feed', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
        }))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(payload)
    })
}

test('only records the six known careers, without guessing a job for an exploring player', () => {
    for (const job of GAME_JOBS) expect(isGameJob(job)).toBe(true)
    for (const job of [undefined, '', 'driverShift', 'FutureJob']) expect(isGameJob(job)).toBe(false)
})
