import { t } from 'elysia'

export namespace RoomModel {
    export const openBody = t.Object({
        eventId: t.String({ format: 'uuid' })
    })
    export type openBody = typeof openBody.static

    export const roomResponse = t.Object({ roomId: t.String() })
    export type roomResponse = typeof roomResponse.static

    export const groupQuery = t.Object({ groupId: t.String() })
    export type groupQuery = typeof groupQuery.static

    export const activeRoomResponse = t.Object({
        roomId: t.String(),
        groupId: t.String(),
        eventId: t.String(),
        eventName: t.String(),

        createdAt: t.Date(),
        expiresAt: t.Date(),
        creatorId: t.String(),

        /** TrPTools user ids currently holding an open dispatch stream. */
        users: t.Array(t.String()),
        vehicles: t.Number()
    })
    export type activeRoomResponse = typeof activeRoomResponse.static

    export const notScheduled = t.Literal('this shift is not running right now')
    export type notScheduled = typeof notScheduled.static

    export const alreadyOpen = t.Literal('this group already has a room open')
    export type alreadyOpen = typeof alreadyOpen.static
}
