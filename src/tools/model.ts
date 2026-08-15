import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'

export namespace ToolsModel {
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
