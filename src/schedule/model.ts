import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'

export namespace ScheduleModel {
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
        hostLevel: t.Optional(t.Integer({ minimum: 1, maximum: 3 }))
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
        hostLevel: t.Optional(t.Integer({ minimum: 1, maximum: 3 }))
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
        avatar: t.Union([t.String(), t.Null()]),
        /** Set when the person took the slot through Discord. */
        discordId: t.Union([t.String(), t.Null()])
    })
    export type signupUser = typeof signupUser.static

    export const signupSlot = t.Object({
        id: t.String(),
        name: t.String(),
        description: t.String(),
        capacity: t.Number(),
        order: t.Number(),
        signups: t.Array(signupUser)
    })
    export type signupSlot = typeof signupSlot.static

    /**
     * One rank's sign-up sheet as it applies to a single occurrence.
     *
     * `robloxRank` travels with it so a client can explain why a sheet is
     * visible without a second lookup.
     */
    export const signupSheet = t.Object({
        signupId: t.String(),
        rankId: t.String(),
        rankName: t.String(),
        robloxRank: t.Number(),
        name: t.String(),
        description: t.String(),
        color: t.String(),
        slots: t.Array(signupSlot)
    })
    export type signupSheet = typeof signupSheet.static

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
        /** Only the sheets the caller's own rank permits. */
        sheets: t.Array(signupSheet)
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
        limit: t.Optional(t.String()),
        /** Restrict to one shift, for that shift's own page. */
        eventId: t.Optional(t.String({ format: 'uuid' }))
    })
    export type occurrencesRequest = typeof occurrencesRequest.static

    export const signupBody = t.Object({
        slotId: t.String({ format: 'uuid' }),
        eventId: t.String({ format: 'uuid' }),
        occurrence: t.Date()
    })
    export type signupBody = typeof signupBody.static

    export const invalidRRule = t.Literal('invalid recurrence rule')
    export type invalidRRule = typeof invalidRRule.static

    export const slotFull = t.Literal('that slot is full')
    export type slotFull = typeof slotFull.static

    export const alreadySignedUp = t.Literal('already signed up for this shift')
    export type alreadySignedUp = typeof alreadySignedUp.static

    export const wrongRank = t.Literal('your rank cannot take that slot')
    export type wrongRank = typeof wrongRank.static
}
