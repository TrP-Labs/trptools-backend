import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'
import { translationsPatch, translationsResponse } from '../utils/translations'

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

        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,

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
        /** Per-language versions of the text fields above. */
        translations: t.Optional(translationsPatch),

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
        /** Per-language versions of the text fields above. */
        translations: t.Optional(translationsPatch),

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
        /** The row's own id, which is what moving or removing one names. */
        id: t.String(),
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
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,

        capacity: t.Number(),
        order: t.Number(),
        /**
         * The ranks this slot is for, by name. Empty means every member of the
         * group, which is what an untouched rank list means everywhere.
         */
        rankNames: t.Array(t.String()),
        /**
         * Whether this viewer may take it.
         *
         * Not always true of a slot that arrived: somebody who may move other
         * people's sign-ups sees slots they cannot fill themselves, and the
         * page has no other way to tell the two apart.
         */
        canFill: t.Boolean(),
        signups: t.Array(signupUser)
    })
    export type signupSlot = typeof signupSlot.static

    /**
     * One sign-up sheet as it applies to a single occurrence.
     *
     * Sheets belong to the group rather than to a rank, so nothing here names
     * one: who may fill a slot is the slot's own list, reported as
     * `rankNames` beside the `canFill` this viewer got.
     */
    export const signupSheet = t.Object({
        sheetId: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,

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
        /** Per-language versions of the shift's name and description. */
        translations: translationsResponse,
        start: t.Date(),
        end: t.Date(),
        /**
         * Whether sign-ups are open for this occurrence yet. `sheets` is empty
         * whenever this is false, so a client never renders an empty form.
         */
        signupsOpen: t.Boolean(),
        signupsOpenAt: t.Date(),
        /**
         * Whether any sheet on this shift has a slot this viewer may see at
         * all, regardless of the window. Lets a client say "sign-ups open in
         * an hour" only to somebody who will actually get a form, rather than
         * advertising one to everybody who cannot use it.
         */
        sheetsAvailable: t.Boolean(),
        /**
         * Whether this viewer may move or remove other people's sign-ups on
         * this occurrence (`EDIT_SIGNUPS`). Carried per occurrence for the
         * same reason `discordRequired` is: the shifts page draws occurrences
         * from more than one group at once, and the grant is per group.
         */
        canEditSignups: t.Boolean(),
        /**
         * Whether this group asks for a linked Discord account before a slot
         * can be taken.
         *
         * Carried on the occurrence rather than left to the client to look up
         * per group: whoever is drawing sheets needs it to disable the button
         * and explain why, and the shifts page draws occurrences from more
         * than one group at once.
         */
        discordRequired: t.Boolean(),
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

    /** Where a host is moving somebody else's sign-up to. */
    export const moveSignupBody = t.Object({
        slotId: t.String({ format: 'uuid' })
    })
    export type moveSignupBody = typeof moveSignupBody.static

    export const invalidRRule = t.Literal('invalid recurrence rule')
    export type invalidRRule = typeof invalidRRule.static

    export const slotFull = t.Literal('that slot is full')
    export type slotFull = typeof slotFull.static

    export const alreadySignedUp = t.Literal('already signed up for this shift')
    export type alreadySignedUp = typeof alreadySignedUp.static

    export const wrongRank = t.Literal('your rank cannot take that slot')
    export type wrongRank = typeof wrongRank.static

    export const notSameShift = t.Literal('that slot is on a different shift')
    export type notSameShift = typeof notSameShift.static


    export const signupsClosed = t.Literal('sign-ups are not open for that shift yet')
    export type signupsClosed = typeof signupsClosed.static

    export const discordRequired = t.Literal('this group asks you to link a Discord account before signing up')
    export type discordRequired = typeof discordRequired.static
}
