import { Elysia, t } from 'elysia'
import { GroupModel } from './model'
import { Group_ } from './service'
import { globalModel } from '../utils/globalModel'
import { requireUser, sessionPlugin } from '../utils/authPlugin'
import { rateLimit } from '../utils/ratelimit'

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
                async ({ params: { groupId }, body, session }) => {
                    const user = requireUser(session)
                    // Each attempt asks Roblox whether a key is good, and the
                    // answer now says *why* it is not. That is a useful reply
                    // for the manager who typed it and an equally useful one
                    // for someone testing stolen keys through us, so the check
                    // is metered per account.
                    await rateLimit('groups:opencloudkey', user.userId, 10, 300)

                    return Group_.setOpenCloudKey(groupId, body, session)
                },
                {
                    body: GroupModel.openCloudKeyBody,
                    response: {
                        200: globalModel.genericSuccess,
                        400: GroupModel.keyProblem,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: GroupModel.groupInvalid,
                        429: globalModel.rateLimited
                    },
                    detail: {
                        summary: 'Store the group Open Cloud API key',
                        description:
                            'Roblox Open Cloud rejects anonymous group reads. A key scoped to group:read lets TrPTools resolve ranks reliably and at a far higher rate limit than a signed-in user token allows. The key must be owned by a user account — Open Cloud refuses group-owned keys on every group route.'
                    }
                }
            )

            .get(
                '/vehicle-types',
                async ({ params: { groupId }, session }) => Group_.getVehicleTypes(groupId, session),
                {
                    response: {
                        200: GroupModel.vehicleTypeList,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: GroupModel.groupInvalid
                    },
                    detail: {
                        summary: 'Which dispatch list each vehicle belongs in',
                        description:
                            'Vehicle names are matched exactly and case-insensitively. A vehicle that is not listed falls back to a keyword guess, so a model nobody has classified still lands somewhere sensible.'
                    }
                }
            )

            .put(
                '/vehicle-types',
                async ({ params: { groupId }, body, session }) => Group_.setVehicleTypes(groupId, body, session),
                {
                    body: GroupModel.updateVehicleTypesBody,
                    response: {
                        200: globalModel.genericSuccess,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: GroupModel.groupInvalid,
                        409: GroupModel.duplicateVehicleType
                    },
                    detail: { summary: 'Replace the group vehicle type table' }
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
