import { Elysia, t } from 'elysia'
import { RankModel } from './model'
import { Rank } from './service'
import { GroupModel } from '../model'
import { globalModel } from '../../utils/globalModel'
import { sessionPlugin } from '../../utils/authPlugin'

export const ranks = new Elysia({ prefix: '/ranks', tags: ['Ranks'] })
    .use(sessionPlugin)

    .get(
        '/group/:groupId/creatable',
        async ({ params: { groupId }, session }) => Rank.getUnassignedRanks(groupId, session),
        {
            response: {
                200: RankModel.availableRanksResponse,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: GroupModel.groupInvalid
            },
            detail: { summary: 'Roblox roles not yet bound in this group' }
        }
    )

    .get('/group/:groupId/roster', async ({ params: { groupId }, session }) => Rank.getRoster(groupId, session), {
        response: {
            200: RankModel.rosterResponse,
            404: GroupModel.groupInvalid
        },
        detail: {
            summary: 'The public roster',
            description:
                'Ranks the group has marked visible, each with its description, colour and the members holding it.'
        }
    })

    .get('/group/:groupId', async ({ params: { groupId }, session }) => Rank.getAllRanks(groupId, session), {
        response: {
            200: RankModel.rankListResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: GroupModel.groupInvalid
        },
        detail: { summary: 'List bound ranks' }
    })

    .post('/group/:groupId', async ({ params: { groupId }, body, session }) => Rank.bindRank(groupId, body.robloxId, session), {
        body: RankModel.createRankBody,
        response: {
            200: RankModel.createRankResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: RankModel.rankInvalid,
            409: RankModel.rankExists
        },
        detail: { summary: 'Bind a Roblox role to this group' }
    })

    .group('/:rankId', (app) =>
        app
            .get('/', async ({ params: { rankId }, session }) => Rank.getRank(rankId, session), {
                params: t.Object({ rankId: t.String({ format: 'uuid' }) }),
                response: {
                    200: RankModel.rankItemResponse,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: RankModel.rankInvalid
                },
                detail: { summary: 'Read a bound rank' }
            })

            .patch('/', async ({ params: { rankId }, body, session }) => Rank.editRank(rankId, body, session), {
                params: t.Object({ rankId: t.String({ format: 'uuid' }) }),
                body: RankModel.editRankBody,
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: RankModel.rankInvalid
                },
                detail: { summary: 'Update a rank binding' }
            })

            .delete('/', async ({ params: { rankId }, session }) => Rank.unbindRank(rankId, session), {
                params: t.Object({ rankId: t.String({ format: 'uuid' }) }),
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: RankModel.rankInvalid
                },
                detail: { summary: 'Unbind a rank' }
            })
    )
