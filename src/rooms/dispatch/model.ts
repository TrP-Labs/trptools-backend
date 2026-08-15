import { t } from 'elysia'

export namespace Vehicles {
    export const category = t.Union([
        t.Literal('TROLLEYBUS'),
        t.Literal('SERVICE'),
        t.Literal('STAFF'),
        t.Literal('OTHER')
    ])
    export type category = typeof category.static

    /** The raw shape pasted in from the game. */
    export const seedVehicle = t.Object({
        Id: t.Union([t.Integer(), t.String()]),
        OwnerId: t.Union([t.Integer(), t.String()]),
        Name: t.String({ maxLength: 120 }),
        Depot: t.String({ maxLength: 120 })
    })
    export type seedVehicle = typeof seedVehicle.static

    export const importBody = t.Array(seedVehicle, { maxItems: 500 })
    export type importBody = typeof importBody.static

    export const vehicle = t.Object({
        id: t.String(),
        ownerId: t.String(),
        name: t.String(),
        /** The spawn name as the game reported it. */
        depot: t.String(),
        /**
         * The depot row that spawn name resolved to, or null when nothing
         * matched. Dispatchers use it to spot a route that does not serve the
         * vehicle's depot.
         */
        depotId: t.Union([t.String(), t.Null()]),

        /** The assigned route id, or a literal label such as "SV". */
        route: t.Union([t.String(), t.Null()]),
        /** Resolved presentation for the assigned route, when it is a real one. */
        routeName: t.Union([t.String(), t.Null()]),
        routeColor: t.Union([t.String(), t.Null()]),

        category: category,
        assigned: t.Boolean(),
        towing: t.Boolean(),
        note: t.String()
    })
    export type vehicle = typeof vehicle.static

    export const vehicleList = t.Array(vehicle)
    export type vehicleList = typeof vehicleList.static

    export const modifyBody = t.Object({
        route: t.Optional(t.Union([t.String({ maxLength: 64 }), t.Null()])),
        assigned: t.Optional(t.Boolean()),
        towing: t.Optional(t.Boolean()),
        note: t.Optional(t.String({ maxLength: 200 })),
        category: t.Optional(category)
    })
    export type modifyBody = typeof modifyBody.static

    export const solveBody = t.Object({
        /** Reassign vehicles that already hold a route. Defaults to false. */
        includeAssigned: t.Optional(t.Boolean()),
        /** Restrict solving to these vehicle ids. */
        vehicleIds: t.Optional(t.Array(t.String({ maxLength: 32 }), { maxItems: 500 }))
    })
    export type solveBody = typeof solveBody.static

    export const solveResponse = t.Object({
        solved: t.Number(),
        skipped: t.Number(),
        assignments: t.Array(t.Object({ vehicleId: t.String(), route: t.Union([t.String(), t.Null()]) }))
    })
    export type solveResponse = typeof solveResponse.static

    /** Who currently holds an open stream on the room. */
    export const presentUser = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()]),
        /** True for the person who opened the room. */
        host: t.Boolean()
    })
    export const presenceList = t.Array(presentUser)
    export type presenceList = typeof presenceList.static

    export const importResponse = t.Object({
        added: t.Number(),
        removed: t.Number(),
        total: t.Number()
    })
    export type importResponse = typeof importResponse.static

    /** Events pushed down the SSE stream. */
    export const streamEvent = t.Union([
        t.Object({ event: t.Literal('SYNC'), data: vehicleList }),
        t.Object({ event: t.Literal('ADD'), data: vehicle }),
        t.Object({ event: t.Literal('UPDATE'), data: t.Composite([t.Object({ id: t.String() }), modifyBody]) }),
        t.Object({ event: t.Literal('DELETE'), data: t.String() }),
        t.Object({ event: t.Literal('PRESENCE'), data: t.Array(t.String()) }),
        t.Object({ event: t.Literal('CLOSED') }),
        t.Object({ event: t.Literal('HEARTBEAT') })
    ])
    export type streamEvent = typeof streamEvent.static
}
