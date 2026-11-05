import { t } from 'elysia'
import { Vehicles } from '../rooms/dispatch/model'

export namespace DriverModel {
    /** Another vehicle on the board, as the driver needs to find it. */
    export const otherVehicle = t.Object({
        id: t.String(),
        name: t.String(),
        /** Its driver's Roblox user id. */
        ownerId: t.String()
    })

    /** Something the shift's host sent to everybody, such as "return to your depot". */
    export const notice = t.Object({
        id: t.String(),
        action: t.Union([t.Literal('RETURN_DEPOT'), t.Literal('REMINDER')]),
        label: t.String(),
        /** When it was sent, in milliseconds. */
        at: t.Union([t.Number(), t.Null()])
    })

    export const instruction = t.Object({
        roomId: t.String(),
        groupId: t.String(),
        groupName: t.String(),
        shift: t.Object({
            eventId: t.String(),
            name: t.String(),
            /** ISO 8601 start of the occurrence. */
            occurrence: t.String(),
            /** When the shift ends, in milliseconds. Extensions move it. */
            endsAt: t.Number()
        }),
        vehicle: t.Object({
            id: t.String(),
            name: t.String(),
            depot: t.String(),
            category: Vehicles.category
        }),
        /**
         * The route dispatch assigned. `id` is null for a literal label a
         * dispatcher typed rather than a route of the group's.
         */
        route: t.Union([t.Object({ id: t.Union([t.String(), t.Null()]), name: t.String(), color: t.Union([t.String(), t.Null()]) }), t.Null()]),
        /** Written instructions in place of a route, when dispatch gave some. */
        note: t.Union([t.String(), t.Null()]),
        /** Whether a dispatcher has ticked the assignment as confirmed with you. */
        confirmed: t.Boolean(),
        /** The vehicle you are to tow. Only a service vehicle is ever given one. */
        towing: t.Union([otherVehicle, t.Null()]),
        /** The tow truck coming for you, if one has been sent. */
        towedBy: t.Union([otherVehicle, t.Null()]),
        /** The last stop, continue or end-of-shift order sent through the game. */
        order: t.Union([t.Literal('STOP'), t.Literal('CONTINUE'), t.Literal('END_SHIFT'), t.Null()]),
        orderAt: t.Union([t.Number(), t.Null()]),
        /** Where a route or end of shift is on its way to the game, when a server feeds the room. */
        delivery: t.Union([t.Literal('QUEUED'), t.Literal('SENT'), t.Null()]),
        /** A service vehicle's job: its progress and where it was sent. */
        service: t.Union([t.Object({ status: Vehicles.serviceStatus, location: t.String() }), t.Null()]),
        returnToDepot: t.Boolean(),
        notices: t.Array(notice),
        /**
         * Changes whenever anything above changes, and only then: the
         * vehicle's own revision and its room's, as `<vehicle>.<room>`. Both
         * only ever count up, so a client can tell newer from older.
         */
        stateIndex: t.String()
    })
    export type instruction = typeof instruction.static

    export const response = t.Object({
        /**
         * Every vehicle's `roomId/vehicleId@stateIndex`, joined with commas:
         * one string to compare between polls. Empty when you are on no board.
         */
        stateIndex: t.String(),
        vehicles: t.Array(instruction)
    })
    export type response = typeof response.static
}
