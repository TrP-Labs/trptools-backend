import { Elysia, redirect, t } from 'elysia'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'
import { GroupModel } from '../groups/model'
import { BotModel } from './model'
import { Bot } from './service'

export const bot = new Elysia({ prefix: '/bot', tags: ['Bot'] })
    /**
     * The install callback is a top-level navigation from Discord and carries
     * no session cookie of its own worth trusting, so it sits outside the
     * session plugin and authorises itself through the parked state value.
     */
    .get('/callback', async ({ query }) => redirect(await Bot.completeInstall(query), 302), {
        query: BotModel.callbackQuery,
        detail: {
            summary: 'Finish adding the bot to a Discord server',
            description: 'Discord redirects here after the install. Always answers with a redirect to the dashboard.'
        }
    })

    .use(sessionPlugin)

    .get('/install', async ({ query, session }) => Bot.beginInstall(query.groupId, session), {
        query: BotModel.installQuery,
        response: {
            200: BotModel.installResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: GroupModel.groupInvalid,
            503: BotModel.unavailable
        },
        detail: {
            summary: 'Begin adding the bot to a Discord server',
            description: 'Returns the Discord authorisation URL to send the browser to.'
        }
    })

    .group('/:groupId', (app) =>
        app
            .get('/', async ({ params: { groupId }, session }) => Bot.overview(groupId, session), {
                response: {
                    200: BotModel.overview,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: GroupModel.groupInvalid
                },
                detail: {
                    summary: 'The bot page for a group',
                    description:
                        'Stored configuration plus the bot\'s live standing in the guild, including which ' +
                        'required permissions it currently holds.'
                }
            })

            .patch('/', async ({ params: { groupId }, body, session }) => Bot.update(groupId, body, session), {
                body: BotModel.updateBody,
                response: {
                    200: BotModel.config,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: BotModel.notConnected
                },
                detail: { summary: 'Update bot settings' }
            })

            .delete('/', async ({ params: { groupId }, session }) => Bot.remove(groupId, session), {
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: BotModel.notConnected
                },
                detail: {
                    summary: 'Disconnect the Discord server',
                    description: 'Has the bot leave the guild and clears every channel and role binding.'
                }
            })

            .get(
                '/channels',
                async ({ params: { groupId }, query, session }) =>
                    Bot.channels(groupId, session, query.refresh === '1'),
                {
                    query: BotModel.refreshQuery,
                    response: {
                        200: BotModel.channelList,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: BotModel.notConnected
                    },
                    detail: {
                        summary: 'Channels the bot could post in',
                        description:
                            'Each carries whether the bot can currently read and send there. Pass refresh=1 to ' +
                            'drop the cached guild reads first.'
                    }
                }
            )

            .get(
                '/cleanup',
                async ({ params: { groupId }, query, session }) =>
                    Bot.cleanup(groupId, session, query.refresh === '1'),
                {
                    query: BotModel.refreshQuery,
                    response: {
                        200: BotModel.cleanupStatus,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: BotModel.notConnected
                    },
                    detail: {
                        summary: 'Whether the end-of-shift cleanup can run',
                        description:
                            'Every channel the cleanup would delete from, and whether the bot holds Manage ' +
                            'Messages and Read Message History there. Pass refresh=1 to drop the cached ' +
                            'guild reads first.'
                    }
                }
            )

            .get(
                '/roles',
                async ({ params: { groupId }, query, session }) => Bot.roles(groupId, session, query.refresh === '1'),
                {
                    query: BotModel.refreshQuery,
                    response: {
                        200: BotModel.roleList,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: BotModel.notConnected
                    },
                    detail: {
                        summary: 'Roles in the connected guild',
                        description: 'Each carries whether the bot can actually mention it.'
                    }
                }
            )
    )
