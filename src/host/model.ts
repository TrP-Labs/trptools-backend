import { t } from 'elysia'

export namespace HostModel {
    export const action = t.Union([t.Literal('STAFF_START'), t.Literal('EDIT_SHIFT'), t.Literal('BEGIN'), t.Literal('RETURN_DEPOT'), t.Literal('COMPLETE'), t.Literal('REMINDER')])
    export const entry = t.Object({
        id: t.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' }),
        label: t.String({ minLength: 1, maxLength: 160 }),
        action,
        reference: t.Union([t.Literal('START'), t.Literal('END')]),
        offsetMinutes: t.Integer({ minimum: -1440, maximum: 1440 }),
        audience: t.Union([t.Literal('HOST'), t.Literal('DISPATCH'), t.Literal('ALL')]),
        optional: t.Boolean(),
        automation: t.Boolean()
    })
    export type Entry = typeof entry.static
    export const schedule = t.Object({
        entries: t.Array(entry, { maxItems: 32 }),
        depotReminderEnabled: t.Boolean(),
        depotReminderMinutes: t.Integer({ minimum: 0, maximum: 1440 })
    })
    export type Schedule = typeof schedule.static
    export const timelineEntry = t.Composite([entry, t.Object({
        dueAt: t.Number(),
        status: t.Union([t.Literal('WAITING'), t.Literal('READY'), t.Literal('QUEUED'), t.Literal('RUNNING'), t.Literal('ACKNOWLEDGED'), t.Literal('AUTOMATED'), t.Literal('ACTIVATED'), t.Literal('SKIPPED'), t.Literal('IGNORED')]),
        actorId: t.Optional(t.String()),
        changedAt: t.Optional(t.Number()),
        leaseUntil: t.Optional(t.Number()),
        source: t.Optional(t.Union([t.Literal('STAFF'), t.Literal('AUTOMATION')]))
    })])
    export type TimelineEntry = typeof timelineEntry.static
    export const snapshot = t.Object({
        roomId: t.String(), eventId: t.String(), eventName: t.String(), occurrence: t.String(),
        endsAt: t.Number(), activeUntil: t.Number(),
        timeline: t.Array(timelineEntry),
        note: t.String(), ownerRobloxId: t.Union([t.String(), t.Null()]),
        imageUrl: t.Union([t.String(), t.Null()])
    })
    export type Snapshot = typeof snapshot.static
    export const eventBody = t.Object({
        operation: t.Union([t.Literal('ACTIVATE'), t.Literal('SKIP'), t.Literal('ACKNOWLEDGE'), t.Literal('RESCHEDULE')]),
        reference: t.Optional(t.Union([t.Literal('START'), t.Literal('END')])),
        offsetMinutes: t.Optional(t.Integer({ minimum: -1440, maximum: 1440 }))
    })
    export const noteBody = t.Object({
        note: t.String({ maxLength: 1000 }),
        ownerRobloxId: t.Union([t.String({ pattern: '^[0-9]{1,20}$' }), t.Null()]),
        imageUrl: t.Optional(t.Union([t.String({ maxLength: 2048 }), t.Null()]))
    })
    export type Note = typeof noteBody.static
}
