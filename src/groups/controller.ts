import { Elysia, t } from 'elysia'
import { GroupModel } from './model'
import { Group_ } from './service'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const group = new Elysia({ prefix: '/groups', tags: ['Groups'] })
    .use(sessionPlugin)

    .post('/', async ({ body, session }) => Group_.createGroup(body, session), {
        body: GroupModel.createGroupBody,
        response: {
            200: GroupModel.createGroupResponse,
            400: GroupModel.groupInvalid,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            409: GroupModel.groupExists
        },
        detail: { summary: 'Add a Roblox group you own to TrPTools' }
    })

    .get('/creatable', async ({ session }) => Group_.getCreatableGroups(session), {
        response: {
            200: GroupModel.creatableGroupList,
            401: globalModel.unauthorized
        },
        detail: { summary: 'Roblox groups you own that are not on TrPTools yet' }
    })

    .get('/', async ({ session }) => Group_.getGroups(session), {
        response: {
            200: GroupModel.groupList,
            401: globalModel.unauthorized
        },
        detail: { summary: 'Groups you can act in' }
    })

    .group('/:groupId', (app) =>
        app
            .get('/', async ({ params: { groupId }, session }) => Group_.getGroup(groupId, session), {
                response: {
                    200: GroupModel.groupResponse,
                    404: GroupModel.groupInvalid
                },
                detail: { summary: 'Read a group by id or slug' }
            })

            .patch('/', async ({ params: { groupId }, body, session }) => Group_.updateGroup(groupId, body, session), {
                body: GroupModel.updateGroupBody,
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: GroupModel.groupInvalid,
                    409: GroupModel.slugTaken
                },
                detail: { summary: 'Update group settings and visibility' }
            })

            .delete('/', async ({ params: { groupId }, session }) => Group_.deleteGroup(groupId, session), {
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: GroupModel.groupInvalid
                },
                detail: { summary: 'Remove a group from TrPTools' }
            })

            .put(
                '/open-cloud-key',
                async ({ params: { groupId }, body, session }) => Group_.setOpenCloudKey(groupId, body, session),
                {
                    body: GroupModel.openCloudKeyBody,
                    response: {
                        200: globalModel.genericSuccess,
                        400: GroupModel.invalidKey,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: GroupModel.groupInvalid
                    },
                    detail: {
                        summary: 'Store the group Open Cloud API key',
                        description:
                            'Roblox Open Cloud rejects anonymous group reads. A key scoped to group:read lets TrPTools resolve ranks reliably and at a far higher rate limit than a signed-in user token allows.'
                    }
                }
            )

            .get('/audit', async ({ params: { groupId }, session }) => Group_.getAudit(groupId, session), {
                response: {
                    200: GroupModel.auditList,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden
                },
                detail: { summary: 'Recent administrative changes' }
            })
    )
