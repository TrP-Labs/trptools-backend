import { t } from 'elysia'

/**
 * What a hosted TrP server sends on its live feed.
 *
 * Deliberately forgiving: the game stops sending for good on any status it
 * does not expect, and a 400 over one field it has since renamed would take a
 * whole shift's feed down. So everything the board can do without is
 * optional, and anything unrecognised is ignored rather than refused.
 */
export namespace RealtimeModel {
    const id = t.Union([t.Integer(), t.String({ maxLength: 32 })])
    const position = t.Optional(t.Object({ X: t.Number(), Y: t.Number(), Z: t.Number() }))

    export const user = t.Object({
        Username: t.Optional(t.String({ maxLength: 64 })),
        ID: id,
        Job: t.Optional(t.String({ maxLength: 64 })),
        Position: position
    })
    export type User = typeof user.static

    export const vehicle = t.Object({
        Name: t.String({ maxLength: 120 }),
        Id: id,
        Depot: t.Optional(t.String({ maxLength: 120 })),
        OwnerId: id,
        Route: t.Optional(t.String({ maxLength: 64 })),
        AssignedRoute: t.Optional(t.String({ maxLength: 64 })),
        TabletEquipped: t.Optional(t.Boolean()),
        Position: position
    })
    export type Vehicle = typeof vehicle.static

    export const report = t.Object({
        Users: t.Optional(t.Array(user, { maxItems: 300 })),
        Vehicles: t.Optional(t.Array(vehicle, { maxItems: 1000 })),
        ServerData: t.Optional(t.Object({
            runtime: t.Optional(t.Number()),
            gametime: t.Optional(t.Number()),
            routes: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 200 }))
        }))
    })
    export type Report = typeof report.static

    export const command = t.Object({
        DispatcherId: t.Integer(),
        Vehicle: t.Integer(),
        Command: t.Object({
            Type: t.Union([t.Literal('Route'), t.Literal('Tow'), t.Literal('Stop'), t.Literal('Continue'), t.Literal('EndShift')]),
            Value: t.Optional(t.Union([t.String(), t.Integer()]))
        })
    })
    export const commandList = t.Array(command)
}
