import { describe, expect, test } from 'bun:test'
import { instructionsFor, type DriverRow } from './rules'

const ROUTE = '11111111-1111-1111-1111-111111111111'
const lookup = {
    groupName: 'Demo',
    route: (id: string) => (id === ROUTE ? { id, name: '6', color: '#ff0000' } : null),
    noteRoute: 'NOTE'
}

function row(vehicle: Record<string, string>, timeline: unknown[] = [], extra: Partial<DriverRow> = {}): DriverRow {
    return {
        roomId: 'room1',
        vehicle: { id: '1042', name: 'ZiU-9', depot: 'Main Island Depot', category: 'TROLLEYBUS', rev: '3', ...vehicle },
        towing: null,
        towedBy: null,
        room: { groupId: 'g', eventId: 'e', eventName: 'Evening', occurrence: '2026-11-05T19:00:00.000Z', expiresAt: '1000', revision: '7', timeline: JSON.stringify(timeline) },
        ...extra
    }
}

describe('what a driver is told', () => {
    test('a route by id resolves to its name and color; a typed label is shown as typed', () => {
        expect(instructionsFor(row({ route: ROUTE }), lookup).route).toEqual({ id: ROUTE, name: '6', color: '#ff0000' })
        expect(instructionsFor(row({ route: 'SV' }), lookup).route).toEqual({ id: null, name: 'SV', color: null })
        expect(instructionsFor(row({ route: '22222222-2222-2222-2222-222222222222' }), lookup).route).toBeNull()
    })

    test('a written note is an instruction, not a route', () => {
        const told = instructionsFor(row({ route: 'NOTE', note: 'Wait at the depot' }), lookup)
        expect(told.route).toBeNull()
        expect(told.note).toBe('Wait at the depot')
    })

    test('only a service vehicle is ever told to tow, but anybody can be towed', () => {
        const truck = { id: '9', name: 'Tow', ownerId: '5' }
        expect(instructionsFor(row({}, [], { towing: truck }), lookup).towing).toBeNull()
        expect(instructionsFor(row({ category: 'SERVICE' }, [], { towing: truck }), lookup).towing).toEqual(truck)
        expect(instructionsFor(row({}, [], { towedBy: truck }), lookup).towedBy).toEqual(truck)
    })

    test('orders and delivery are read back, and anything unknown is nothing', () => {
        const told = instructionsFor(row({ order: 'STOP', orderAt: '1234', command: 'SENT' }), lookup)
        expect(told.order).toBe('STOP')
        expect(told.orderAt).toBe(1234)
        expect(told.delivery).toBe('SENT')
        expect(instructionsFor(row({ order: 'JUMP', command: 'LOST' }), lookup)).toMatchObject({ order: null, orderAt: null, delivery: null })
    })

    test('the depot call counts once it has been sent out, not while it is merely due', () => {
        const due = [{ id: 'return-depot', action: 'RETURN_DEPOT', label: 'Back', audience: 'DISPATCH', status: 'READY' }]
        expect(instructionsFor(row({}, due), lookup).returnToDepot).toBe(false)
        const sent = [{ ...due[0], status: 'ACTIVATED', awaitingAck: true, changedAt: 50 }]
        const told = instructionsFor(row({}, sent), lookup)
        expect(told.returnToDepot).toBe(true)
        expect(told.notices).toEqual([{ id: 'return-depot', action: 'RETURN_DEPOT', label: 'Back', at: 50 }])
    })

    test('a reminder for hosts only is not a driver notice', () => {
        const items = [{ id: 'r', action: 'REMINDER', label: 'Hosts', audience: 'HOST', status: 'ACTIVATED' }]
        expect(instructionsFor(row({}, items), lookup).notices).toEqual([])
    })

    test('the state index is the vehicle revision and the room revision', () => {
        expect(instructionsFor(row({}), lookup).stateIndex).toBe('3.7')
        expect(instructionsFor(row({ rev: '' }, [], { room: { ...row({}).room, revision: '' } }), lookup).stateIndex).toBe('0.0')
    })
})
