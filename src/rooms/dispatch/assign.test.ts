import { describe, expect, test } from 'bun:test'
import {
    inferCategory,
    matchRule,
    NOTE_ROUTE,
    solve,
    type SolverContext,
    type SolverRoute,
    type SolverVehicle
} from './assign'

/**
 * The assignment rules, which are the part most likely to be quietly wrong.
 *
 * Every case here is one that has already been reasoned about the wrong way at
 * least once: a substring pattern claiming a longer vehicle's name, a service
 * van counted as a routing failure, a single-vehicle solve that could not see
 * the board it was being placed into.
 */

function route(id: string, share: number, depots: string[] = []): SolverRoute {
    return {
        id,
        name: id,
        autoAssign: true,
        targetShare: share,
        depotIds: new Set(depots),
        servesAllDepots: depots.length === 0
    }
}

function context(overrides: Partial<SolverContext> = {}): SolverContext {
    const rules = overrides.rules ?? []

    const typesByName = overrides.typesByName ?? new Map()
    if (!overrides.typesByName) {
        for (const rule of rules) {
            const key = rule.pattern.trim().toLowerCase()
            if (!typesByName.has(key)) typesByName.set(key, rule)
        }
    }

    return {
        routes: overrides.routes ?? [route('a', 50), route('b', 50)],
        depotsByKey: overrides.depotsByKey ?? new Map(),
        rules,
        typesByName,
        preferences: overrides.preferences ?? new Map()
    }
}

function vehicle(id: string, extra: Partial<SolverVehicle> = {}): SolverVehicle {
    return {
        id,
        ownerId: id,
        name: 'ZiU-682 (ZiU-9)',
        depot: 'Main Island Depot',
        depotId: null,
        route: null,
        category: 'TROLLEYBUS',
        ...extra
    }
}

describe('classification', () => {
    test('an exact name beats a pattern that merely contains it', () => {
        // "ZiU-682 (ZiU-9)" as a regex happily claims the service vehicle whose
        // name begins with it, which put the tow truck on a passenger route.
        const ctx = context({
            rules: [
                { pattern: 'ZiU-682 (ZiU-9)', category: 'TROLLEYBUS', fixedRoute: null },
                { pattern: 'ZiU-682 (ZiU-9) Service Vehicle', category: 'SERVICE', fixedRoute: null }
            ]
        })

        expect(matchRule('ZiU-682 (ZiU-9) Service Vehicle', ctx)?.category).toBe('SERVICE')
        expect(matchRule('ZiU-682 (ZiU-9)', ctx)?.category).toBe('TROLLEYBUS')
    })

    test('the name match ignores case and surrounding space', () => {
        const ctx = context({ rules: [{ pattern: 'Boat', category: 'STAFF', fixedRoute: null }] })
        expect(matchRule('  boat ', ctx)?.category).toBe('STAFF')
    })

    test('a group that wrote a pattern keeps it', () => {
        const ctx = context({
            rules: [{ pattern: 'service|tow|rescue', category: 'SERVICE', fixedRoute: null }]
        })
        expect(matchRule('Rescue Unit 3', ctx)?.category).toBe('SERVICE')
    })

    test('an unclassified vehicle still lands somewhere sensible', () => {
        expect(inferCategory('Brand New Tram 9000')).toBe('OTHER')
        expect(inferCategory('ZiU-682 (ZiU-9) Service Vehicle')).toBe('SERVICE')
    })
})

describe('what is left alone', () => {
    test('a written note survives even a full reassignment', () => {
        const noted = vehicle('1', { route: NOTE_ROUTE })
        const result = solve([noted], context(), { includeAssigned: true })

        expect(result.assignments).toEqual([])
        expect(result.skipped).toBe(0)
    })

    test('service vans, staff cars and scenery are not routing failures', () => {
        // `skipped` is what the board turns into "check the depots on your
        // routes", so counting these reported a solved room as a broken one.
        const result = solve(
            [
                vehicle('1', { category: 'SERVICE' }),
                vehicle('2', { category: 'STAFF' }),
                vehicle('3', { ownerId: '0' })
            ],
            context()
        )

        expect(result.assignments).toEqual([])
        expect(result.skipped).toBe(0)
    })

    test('a vehicle with nowhere to go is a routing failure', () => {
        const stranded = vehicle('1', { depotId: 'cat-island' })
        const result = solve([stranded], context({ routes: [route('a', 50, ['main-island'])] }))

        expect(result.assignments).toEqual([])
        expect(result.skipped).toBe(1)
    })
})

describe('solving one vehicle', () => {
    const board = () => [
        vehicle('1', { route: 'a' }),
        vehicle('2', { route: 'a' }),
        vehicle('3', { route: 'a' }),
        vehicle('4', { route: 'b' })
    ]

    test('only the named vehicle moves', () => {
        const result = solve(board(), context(), { includeAssigned: true, only: ['4'] })

        expect(result.assignments.map((a) => a.vehicleId)).toEqual(['4'])
    })

    test('it is placed against the whole board, not against itself', () => {
        // Three on "a" and one on "b" with equal shares: whichever vehicle is
        // re-placed belongs on "b". Scoping the *input* rather than the targets
        // hid the other three, and the choice became a coin toss.
        const result = solve(board(), context(), { includeAssigned: true, only: ['1'] })

        expect(result.assignments).toEqual([{ vehicleId: '1', route: 'b' }])
    })

    test('a vehicle nobody named is left exactly as it was', () => {
        const result = solve(board(), context(), { includeAssigned: true, only: ['none-of-them'] })

        expect(result.assignments).toEqual([])
        expect(result.skipped).toBe(0)
    })
})

describe('spreading a whole board', () => {
    test('shares are honoured across the routes a depot can reach', () => {
        const ctx = context({
            routes: [route('busy', 75, ['main']), route('quiet', 25, ['main']), route('elsewhere', 100, ['cat'])]
        })

        // Numbered from one: owner "0" is the game, and vehicle zero would be
        // read as scenery and left where it is.
        const vehicles = Array.from({ length: 8 }, (_, index) =>
            vehicle(String(index + 1), { depotId: 'main' })
        )

        const result = solve(vehicles, ctx)
        const counts = new Map<string, number>()
        for (const assignment of result.assignments) {
            counts.set(assignment.route!, (counts.get(assignment.route!) ?? 0) + 1)
        }

        expect(result.assignments).toHaveLength(8)
        expect(counts.get('elsewhere')).toBeUndefined()
        expect(counts.get('busy')).toBe(6)
        expect(counts.get('quiet')).toBe(2)
    })

    test('a route that does not take automatic assignment never gets one', () => {
        const ctx = context({ routes: [{ ...route('manual', 100), autoAssign: false }] })
        const result = solve([vehicle('1')], ctx)

        expect(result.assignments).toEqual([])
        expect(result.skipped).toBe(1)
    })

    test('a driver is given a route they asked for', () => {
        const ctx = context({
            routes: [route('a', 90), route('b', 10)],
            preferences: new Map([['7', { favourite: new Set(['b']), disliked: new Set(['a']) }]])
        })

        const result = solve([vehicle('1', { ownerId: '7' })], ctx)

        expect(result.assignments).toEqual([{ vehicleId: '1', route: 'b' }])
    })

    test('a route somebody dislikes is left alone while anything else is free', () => {
        const ctx = context({
            routes: [route('a', 90), route('b', 10)],
            preferences: new Map([['7', { favourite: new Set<string>(), disliked: new Set(['a']) }]])
        })

        const result = solve([vehicle('1', { ownerId: '7' })], ctx)

        expect(result.assignments).toEqual([{ vehicleId: '1', route: 'b' }])
    })

    test('a disliked route is still better than no route at all', () => {
        // The driver's depot serves one route and they do not want it. The
        // alternative is a vehicle sitting in the depot all shift.
        const ctx = context({
            routes: [route('only', 100)],
            preferences: new Map([['7', { favourite: new Set<string>(), disliked: new Set(['only']) }]])
        })

        const result = solve([vehicle('1', { ownerId: '7' })], ctx)

        expect(result.assignments).toEqual([{ vehicleId: '1', route: 'only' }])
        expect(result.skipped).toBe(0)
    })

    test('drivers who asked for a route get first dibs on its share', () => {
        // Two routes, one vehicle each. Solved in list order, the driver with
        // no opinion could take the route the second driver asked for — the
        // favourite is honoured regardless, so *both* would end up on it and
        // the other route would run empty. Placing the request first leaves
        // the indifferent driver the route nobody asked for.
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const ctx = context({
                routes: [route('a', 50), route('b', 50)],
                preferences: new Map([['7', { favourite: new Set(['b']), disliked: new Set<string>() }]])
            })

            const result = solve([vehicle('1', { ownerId: '1' }), vehicle('2', { ownerId: '7' })], ctx)
            const byVehicle = new Map(result.assignments.map((a) => [a.vehicleId, a.route]))

            expect(byVehicle.get('2')).toBe('b')
            expect(byVehicle.get('1')).toBe('a')
        }
    })

    test('a favourite is honoured even when that route is already over its share', () => {
        // A driver asking for a route outranks a percentage a manager typed.
        // Ordering keeps this rare; it must not be resolved by refusing them.
        const ctx = context({
            routes: [route('a', 90), route('b', 10)],
            preferences: new Map([['7', { favourite: new Set(['b']), disliked: new Set<string>() }]])
        })

        const vehicles = [
            vehicle('1', { ownerId: '7' }),
            vehicle('2', { ownerId: '7' }),
            vehicle('3', { ownerId: '7' })
        ]

        const result = solve(vehicles, ctx)

        expect(result.assignments.every((assignment) => assignment.route === 'b')).toBe(true)
    })
})
