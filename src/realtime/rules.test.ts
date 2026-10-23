import { describe, expect, test } from 'bun:test'
import {
    adoptedRoute, attendancePercent, attendanceStep, buildCommand, commandKey, gameVehicleNumber,
    isLive, routeByGameName, routeCommandValue, shouldAdoptAssignment
} from './rules'

const routes = [{ id: 'r6', name: '6' }, { id: 'sp', name: 'Sp' }]

describe('commands', () => {
    test('a route and an end of shift replace each other, a tow does not', () => {
        expect(commandKey(12, 'Route')).toBe(commandKey(12, 'EndShift'))
        expect(commandKey(12, 'Stop')).toBe(commandKey(12, 'Continue'))
        expect(commandKey(12, 'Tow')).not.toBe(commandKey(12, 'Route'))
        expect(commandKey(12, 'Route')).not.toBe(commandKey(13, 'Route'))
    })

    test('builds the shape the game validates', () => {
        expect(buildCommand(67, '12', 'Route', '6')).toEqual({
            key: '12:assignment', assignment: true,
            command: { DispatcherId: 67, Vehicle: 12, Command: { Type: 'Route', Value: '6' } }
        })
        expect(buildCommand(67, '31', 'Stop')?.command.Command).toEqual({ Type: 'Stop' })
        expect(buildCommand(67, '31', 'Stop')?.assignment).toBe(false)
    })

    test('refuses what the game would drop', () => {
        expect(buildCommand(0, '12', 'Stop')).toBeNull()
        expect(buildCommand(67, 'abc', 'Stop')).toBeNull()
        expect(gameVehicleNumber('0')).toBeNull()
        expect(gameVehicleNumber('1051')).toBe(1051)
    })

    test('only queues a route the server offers', () => {
        expect(routeCommandValue('6', null)).toBe('6')
        expect(routeCommandValue('6', ['6', '9'])).toBe('6')
        expect(routeCommandValue('sp', ['6', 'Sp'])).toBe('Sp')
        expect(routeCommandValue('15', ['6', '9'])).toBeNull()
    })
})

describe('assignments from the game', () => {
    test('matches routes by in-game name, exact before case-insensitive', () => {
        expect(routeByGameName(routes, 'Sp')?.id).toBe('sp')
        expect(routeByGameName(routes, 'SP')?.id).toBe('sp')
        expect(routeByGameName(routes, '')).toBeNull()
        expect(adoptedRoute(routes, '6')).toBe('r6')
        expect(adoptedRoute(routes, 'X1')).toBe('X1')
        expect(adoptedRoute(routes, '')).toBe('')
    })

    test('adopts a change made in the game, never one older than ours', () => {
        expect(shouldAdoptAssignment('6', '9', '')).toBe(true)
        expect(shouldAdoptAssignment('6', '6', '')).toBe(false)
        expect(shouldAdoptAssignment('6', '9', 'QUEUED')).toBe(false)
        expect(shouldAdoptAssignment('6', '9', 'SENT')).toBe(false)
        expect(shouldAdoptAssignment('6', '', '')).toBe(true)
    })
})

describe('attendance', () => {
    const start = 1_000_000
    const end = start + 3_600_000

    test('credits the time since the previous report', () => {
        expect(attendanceStep(null, start + 15_000, start, end)).toBe(0)
        expect(attendanceStep(start + 15_000, start + 30_000, start, end)).toBe(15)
    })

    test('a gap in the feed is not credited to whoever is there when it resumes', () => {
        expect(attendanceStep(start, start + 600_000, start, end)).toBe(65)
    })

    test('only time inside the shift counts', () => {
        expect(attendanceStep(start - 10_000, start + 5_000, start, end)).toBe(5)
        expect(attendanceStep(end - 5_000, end + 10_000, start, end)).toBe(5)
        expect(attendanceStep(end + 1_000, end + 16_000, start, end)).toBe(0)
    })

    test('percent is of the whole shift, capped at 100', () => {
        expect(attendancePercent(1800, start, end)).toBe(50)
        expect(attendancePercent(9999, start, end)).toBe(100)
        expect(attendancePercent(10, start, start)).toBe(0)
    })

    test('a feed is live for 75 seconds after it last spoke', () => {
        expect(isLive(1000, 70_000)).toBe(true)
        expect(isLive(1000, 80_000)).toBe(false)
        expect(isLive(null, 1)).toBe(false)
    })
})
