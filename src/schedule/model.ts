import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'

export namespace ScheduleModel {
    export const slotBody = t.Object({
        id: t.String(),
        name: t.String(),
        description: t.String(),
        capacity: t.Number(),
        order: t.Number()
    })
    export type slotBody = typeof slotBody.static

    export const slotInput = t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 300 })),
        capacity: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        order: t.Optional(t.Integer({ minimum: 0, maximum: 999 }))
    })
    export type slotInput = typeof slotInput.static

    export const eventResponse = t.Object({
        eventId: t.String(),
        groupId: t.String(),

        name: t.String(),
        slug: t.String(),
        description: t.String(),
        color: t.String(),

        startTime: t.Date(),
        rrule: t.String(),
        duration: t.Number(),
        /** Human readable form of the recurrence rule. */
        recurrenceText: t.String(),

        visibility: globalModel.visibility,
        hostLevel: t.Number(),

        slots: t.Array(slotBody),

        createdAt: t.Date(),
        updatedAt: t.Date()
    })
    export type eventResponse = typeof eventResponse.static

    export const eventsResponse = t.Array(eventResponse)
    export type eventsResponse = typeof eventsResponse.static

    export const createBody = t.Object({
        groupId: t.String(),
        name: t.String({ minLength: 1, maxLength: 100 }),
        description: t.Optional(t.String({ maxLength: 2000 })),
        color: t.Optional(globalModel.hexColor),
        startTime: t.Date(),
        rrule: t.String({ minLength: 1, maxLength: 500 }),
        duration: t.Optional(t.Integer({ minimum: 5, maximum: 1440 })),
        visibility: t.Optional(globalModel.visibility),
        hostLevel: t.Optional(t.Integer({ minimum: 1, maximum: 3 })),
        slots: t.Optional(t.Array(slotInput, { maxItems: 30 }))
    })
    export type createBody = typeof createBody.static

    export const updateBody = t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        description: t.Optional(t.String({ maxLength: 2000 })),
        color: t.Optional(globalModel.hexColor),
        startTime: t.Optional(t.Date()),
        rrule: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        duration: t.Optional(t.Integer({ minimum: 5, maximum: 1440 })),
        visibility: t.Optional(globalModel.visibility),
        hostLevel: t.Optional(t.Integer({ minimum: 1, maximum: 3 })),
        slots: t.Optional(t.Array(slotInput, { maxItems: 30 }))
    })
    export type updateBody = typeof updateBody.static

    export const createResponse = t.Object({ eventId: t.String() })
    export type createResponse = typeof createResponse.static

    export const eventsRequest = t.Object({
        groupId: t.String()
    })
    export type eventsRequest = typeof eventsRequest.static

    export const signupUser = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()])
    })

    /** One concrete instance of a recurring shift, with who signed up. */
    export const occurrenceResponse = t.Object({
        eventId: t.String(),
        groupId: t.String(),
        name: t.String(),
        slug: t.String(),
        description: t.String(),
        color: t.String(),
        start: t.Date(),
        end: t.Date(),
        slots: t.Array(
            t.Composite([
                slotBody,
                t.Object({
                    signups: t.Array(signupUser)
                })
            ])
        )
    })
    export type occurrenceResponse = typeof occurrenceResponse.static

    export const occurrencesResponse = t.Array(occurrenceResponse)
    export type occurrencesResponse = typeof occurrencesResponse.static

    export const occurrencesRequest = t.Object({
        groupId: t.String(),
        /** ISO date. Defaults to now. */
        from: t.Optional(t.String()),
        /** ISO date. Defaults to 30 days out. */
        to: t.Optional(t.String()),
        limit: t.Optional(t.String())
    })
    export type occurrencesRequest = typeof occurrencesRequest.static

    export const signupBody = t.Object({
        slotId: t.String({ format: 'uuid' }),
        occurrence: t.Date()
    })
    export type signupBody = typeof signupBody.static

    export const invalidRRule = t.Literal('invalid recurrence rule')
    export type invalidRRule = typeof invalidRRule.static

    export const slotFull = t.Literal('that slot is full')
    export type slotFull = typeof slotFull.static

    export const alreadySignedUp = t.Literal('already signed up for this shift')
    export type alreadySignedUp = typeof alreadySignedUp.static
}
