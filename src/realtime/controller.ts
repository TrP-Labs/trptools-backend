import { Elysia } from 'elysia'
import { sessionPlugin } from '../utils/authPlugin'
import { globalModel } from '../utils/globalModel'
import { Vehicles } from '../rooms/dispatch/model'
import { RealtimeModel } from './model'
import { GameFeed } from './service'

export const realtime = new Elysia({ prefix: '/realtime', tags: ['Dispatch'] })
    .post('/game/:robloxGroupId', async ({ params, request, body }) =>
        GameFeed.receive(params.robloxGroupId, request.headers.get('authorization'), body), {
        body: RealtimeModel.report,
        response: {
            200: RealtimeModel.commandList,
            401: globalModel.unauthorized,
            404: globalModel.notFound,
            429: globalModel.rateLimited
        },
        detail: {
            summary: 'Live report from a hosted game server',
            description:
                'Sent by hosted TrP servers with `Authorization: Bearer <GAME_FEED_TOKEN>`. Answers 200 with the commands dispatchers have queued for that group, even when no room is open; 404 only when the Roblox group is not registered on TrPTools.'
        }
    })

    .use(sessionPlugin)
    .get('/groups/:groupId/status', async ({ params, session }) => GameFeed.status(params.groupId, session), {
        response: {
            200: Vehicles.gameStatus,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: globalModel.notFound
        },
        detail: { summary: 'Whether a game server is feeding this group' }
    })
