import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'

export namespace ToolsModel {
    // --------------------------------------------------- single-user dispatch

    /**
     * A route on the personal board.
     *
     * The same fields the board draws a group's routes with, minus everything
     * a group decides for itself: there is no target share to set, no badge to
     * upload and nothing to archive. The ids are made up on the spot
     * (`builtin-route-6`) because these routes are not rows anywhere.
     */
    export const dispatchRoute = t.Object({
        id: t.String(),
        name: t.String(),
        color: t.String(),
        textColor: t.String(),
        shape: t.Literal('AUTO'),
        icon: t.Null(),
        order: t.Number(),
        /** Depot ids this route runs from. */
        depots: t.Array(t.String())
    })
    export type dispatchRoute = typeof dispatchRoute.static

    export const dispatchDepot = t.Object({
        id: t.String(),
        number: t.Number(),
        name: t.String(),
        color: t.String()
    })
    export type dispatchDepot = typeof dispatchDepot.static

    export const dispatchSetup = t.Object({
        routes: t.Array(dispatchRoute),
        depots: t.Array(dispatchDepot)
    })
    export type dispatchSetup = typeof dispatchSetup.static

    /** The raw shape pasted in from the game, as the room import takes it. */
    export const dispatchSeedVehicle = t.Object({
        Id: t.Union([t.Integer(), t.String()]),
        OwnerId: t.Union([t.Integer(), t.String()]),
        Name: t.String({ maxLength: 120 }),
        Depot: t.String({ maxLength: 120 })
    })

    export const dispatchImportBody = t.Array(dispatchSeedVehicle, { maxItems: 500 })
    export type dispatchImportBody = typeof dispatchImportBody.static

    export const vehicleCategory = t.Union([
        t.Literal('TROLLEYBUS'),
        t.Literal('SERVICE'),
        t.Literal('STAFF'),
        t.Literal('OTHER')
    ])

    /** A pasted vehicle, classified. Everything else about it is the browser's. */
    export const dispatchVehicle = t.Object({
        id: t.String(),
        ownerId: t.String(),
        name: t.String(),
        depot: t.String(),
        depotId: t.Union([t.String(), t.Null()]),
        category: vehicleCategory
    })
    export const dispatchVehicleList = t.Array(dispatchVehicle)
    export type dispatchVehicleList = typeof dispatchVehicleList.static

    /**
     * The board as it stands, sent up to be solved.
     *
     * All of it, every time: the solver spreads vehicles across routes, so a
     * board it cannot see is one it would fill from empty. `vehicleIds`
     * narrows what may be moved, not what is counted.
     */
    export const dispatchSolveBody = t.Object({
        vehicles: t.Array(
            t.Object({
                id: t.String({ maxLength: 32 }),
                ownerId: t.String({ maxLength: 32 }),
                name: t.String({ maxLength: 120 }),
                depot: t.String({ maxLength: 120 }),
                depotId: t.Optional(t.Union([t.String(), t.Null()])),
                route: t.Optional(t.Union([t.String({ maxLength: 64 }), t.Null()])),
                category: vehicleCategory
            }),
            { maxItems: 500 }
        ),
        includeAssigned: t.Optional(t.Boolean()),
        vehicleIds: t.Optional(t.Array(t.String({ maxLength: 32 }), { maxItems: 500 }))
    })
    export type dispatchSolveBody = typeof dispatchSolveBody.static

    export const dispatchSolveResponse = t.Object({
        solved: t.Number(),
        skipped: t.Number(),
        assignments: t.Array(t.Object({ vehicleId: t.String(), route: t.Union([t.String(), t.Null()]) }))
    })
    export type dispatchSolveResponse = typeof dispatchSolveResponse.static

    /**
     * A stage program is a time-ordered list of light commands:
     * `[seconds, command, targets?]`, matching the format the game consumes
     * and the legacy programmer exported.
     */
    export const programEntry = t.Tuple([
        t.Number({ minimum: 0 }),
        t.String({ maxLength: 60 }),
        t.Optional(t.Array(t.String({ maxLength: 60 }), { maxItems: 32 }))
    ])
    export type programEntry = typeof programEntry.static

    export const program = t.Array(programEntry, { maxItems: 5000 })
    export type program = typeof program.static

    export const stageProgram = t.Object({
        id: t.String(),
        name: t.String(),
        soundId: t.Union([t.String(), t.Null()]),
        program: program,
        visibility: globalModel.visibility,
        authorId: t.String(),
        createdAt: t.Date(),
        updatedAt: t.Date()
    })
    export type stageProgram = typeof stageProgram.static

    export const stageProgramSummary = t.Object({
        id: t.String(),
        name: t.String(),
        soundId: t.Union([t.String(), t.Null()]),
        markers: t.Number(),
        visibility: globalModel.visibility,
        updatedAt: t.Date()
    })
    export const stageProgramList = t.Array(stageProgramSummary)
    export type stageProgramList = typeof stageProgramList.static

    export const createBody = t.Object({
        name: t.String({ minLength: 1, maxLength: 80 }),
        soundId: t.Optional(t.Union([t.String({ maxLength: 32 }), t.Null()])),
        program: program,
        visibility: t.Optional(globalModel.visibility)
    })
    export type createBody = typeof createBody.static

    export const updateBody = t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
        soundId: t.Optional(t.Union([t.String({ maxLength: 32 }), t.Null()])),
        program: t.Optional(program),
        visibility: t.Optional(globalModel.visibility)
    })
    export type updateBody = typeof updateBody.static

    export const createResponse = t.Object({ id: t.String() })
    export type createResponse = typeof createResponse.static

    export const invalidProgram = t.Literal('program is not valid')
    export type invalidProgram = typeof invalidProgram.static
}
