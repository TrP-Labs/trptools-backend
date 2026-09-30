import { t } from 'elysia'
export namespace NotificationModel {
    export const subscription = t.Object({
        endpoint: t.String({ maxLength: 2048 }),
        keys: t.Object({ p256dh: t.String({ maxLength: 100 }), auth: t.String({ maxLength: 32 }) })
    })
    export type subscription = typeof subscription.static
    export const watchBody = t.Object({ enabled: t.Boolean(), eventId: t.Optional(t.String({ format: 'uuid' })) })
    export type watchBody = typeof watchBody.static
    export const state = t.Object({
        following: t.Boolean(), groupReminder: t.Boolean(), shiftReminder: t.Boolean(),
        deviceCount: t.Number(), publicKey: t.Union([t.String(), t.Null()])
    })
    export type state = typeof state.static
}
