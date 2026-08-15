import { Elysia } from 'elysia'
import { RoomModel } from './model'
import { RoomControls } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const rooms = new Elysia({ prefix: '/rooms', tags: ['Rooms'] })
    .use(sessionPlugin)

    .post('/', async ({ body, session }) => RoomControls.createRoom(body, session), {
        body: RoomModel.openBody,
        response: {
            200: RoomModel.roomResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound,
            409: RoomModel.notScheduled
        },
        detail: {
            summary: 'Open a dispatch room',
            description: 'Only allowed while the shift is actually running. One room per group at a time.'
        }
    })

    .get('/', async ({ query, session }) => RoomControls.getId(query.groupId, session), {
        query: RoomModel.groupQuery,
        response: {
            200: RoomModel.roomResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Find the room currently open for a group' }
    })

    .get('/:roomId', async ({ params: { roomId }, session }) => RoomControls.getRoomInfo(roomId, session), {
        response: {
            200: RoomModel.activeRoomResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Inspect an open room' }
    })

    .delete('/:roomId', async ({ params: { roomId }, session }) => RoomControls.closeRoom(roomId, session), {
        response: {
            200: globalModel.genericSuccess,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Close a room' }
    })
