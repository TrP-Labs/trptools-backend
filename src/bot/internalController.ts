import { Elysia, status, t } from 'elysia'
import { env } from '../utils/env'
import { globalModel } from '../utils/globalModel'
import { BotInternal } from './internalModel'
import { BotService } from './internalService'
import { manifestFor } from './manifest'
import { dueActions, releaseClaim } from './scheduler'

/**
 * Routes for the trptools-bot process only.
 *
 * The bot acts on behalf of every group at once, which no user-scoped API key
 * can express, so it presents a shared service token instead. That token is
 * checked here and nowhere else — these routes never consult a session, and
 * the session routes never accept this token.
 */
const serviceAuth = new Elysia({ name: 'trptools/bot-service' }).onBeforeHandle(
    { as: 'scoped' },
    ({ request }) => {
        // An unset token must not mean "let everyone in". With no token
        // configured the internal surface is closed rather than open.
        if (!env.BOT_SERVICE_TOKEN) throw status(401, 'Unauthorized')

        const header = request.headers.get('authorization') ?? ''
        const match = /^Bearer\s+(.+)$/i.exec(header.trim())

        if (!match?.[1] || match[1] !== env.BOT_SERVICE_TOKEN) throw status(401, 'Unauthorized')
    }
)

export const botInternal = new Elysia({ prefix: '/bot/internal', tags: ['Bot'] })
    .use(serviceAuth)

    .get('/guilds', async () => BotService.guilds(), {
        response: { 200: BotInternal.guilds, 401: globalModel.unauthorized },
        detail: {
            summary: 'Every connected guild, for the bot',
            description: 'Configuration and sign-up sheets for all groups with a Discord server attached.'
        }
    })

    .get('/due', async () => dueActions(), {
        response: { 200: BotInternal.dueActions, 401: globalModel.unauthorized },
        detail: {
            summary: 'Automated actions that are due now',
            description:
                'Each action is handed out at most once. Polling this repeatedly will not produce duplicates; ' +
                'release an action explicitly if the bot fails to carry it out.'
        }
    })

    .post(
        '/due/release',
        async ({ body }) => {
            await releaseClaim(body.action, body.eventId, body.occurrence)
            return 'Success' as globalModel.genericSuccess
        },
        {
            body: t.Object({
                action: BotInternal.dueAction.properties.action,
                eventId: t.String({ format: 'uuid' }),
                occurrence: t.String()
            }),
            response: { 200: globalModel.genericSuccess, 401: globalModel.unauthorized },
            detail: {
                summary: 'Hand an action back after a failure',
                description: 'Lets the next poll retry it, instead of the shift silently losing its announcement.'
            }
        }
    )

    .group('/guilds/:guildId', (app) =>
        app
            .get('/', async ({ params: { guildId } }) => BotService.guild(guildId), {
                response: { 200: BotInternal.guild, 401: globalModel.unauthorized, 404: globalModel.notFound },
                detail: { summary: 'One guild’s configuration and sheets' }
            })

            .get('/shift', async ({ params: { guildId }, query }) => BotService.shift(guildId, query.when ?? 'next'), {
                query: BotInternal.shiftQuery,
                response: { 200: BotInternal.shiftOrNull, 401: globalModel.unauthorized, 404: globalModel.notFound },
                detail: {
                    summary: 'The next or currently running shift',
                    description: '`current` matches the dispatch room’s own idea of live, grace period included.'
                }
            })

            .get('/occurrence', async ({ params: { guildId }, query }) => BotService.occurrence(guildId, query), {
                query: BotInternal.occurrenceQuery,
                response: {
                    200: BotInternal.occurrence,
                    400: globalModel.badRequest,
                    401: globalModel.unauthorized,
                    404: globalModel.notFound
                },
                detail: { summary: 'One dated occurrence with its sheets and sign-ups' }
            })

            .post('/signup', async ({ params: { guildId }, body }) => BotService.signup(guildId, body), {
                body: BotInternal.signupBody,
                response: {
                    200: BotInternal.signupResult,
                    400: globalModel.badRequest,
                    401: globalModel.unauthorized,
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Take, move or release a slot from Discord',
                    description:
                        'Selecting a slot already held releases it; selecting another on the same sheet moves. ' +
                        'A linked Discord account is recorded as its TrPTools user so both halves show one person.'
                }
            })

            .get(
                '/manifest',
                async ({ params: { guildId }, set }) => {
                    const png = await manifestFor(guildId)

                    // 404 is the ordinary answer for most of a shift's life —
                    // it means no dispatch room is open, which is what tells
                    // the bot to stop asking rather than an error to report.
                    if (!png) return status(404, 'Not Found')

                    set.headers['content-type'] = 'image/png'
                    return new Response(png as unknown as BodyInit, {
                        headers: { 'content-type': 'image/png' }
                    })
                },
                {
                    detail: {
                        summary: 'The live dispatch board as a PNG',
                        description: '404 when no dispatch room is open for the guild’s group.'
                    }
                }
            )

            .put('/note', async ({ params: { guildId }, body }) => BotService.setNote(guildId, body), {
                body: BotInternal.noteBody,
                response: {
                    200: globalModel.genericSuccess,
                    400: globalModel.badRequest,
                    401: globalModel.unauthorized,
                    404: globalModel.notFound
                },
                detail: {
                    summary: 'Set the note and server override for one occurrence',
                    description: 'What /edit-shift writes, and what the start announcement reads back.'
                }
            })
    )
