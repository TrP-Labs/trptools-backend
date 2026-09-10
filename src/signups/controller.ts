import { Elysia, t } from 'elysia'
import { SignupModel } from './model'
import { Signups } from './service'
import { GroupModel } from '../groups/model'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin } from '../utils/authPlugin'

export const signups = new Elysia({ prefix: '/signups', tags: ['Sign-ups'] })
    .use(sessionPlugin)

    .get('/', async ({ query, session }) => Signups.list(query.groupId, session), {
        query: SignupModel.listRequest,
        response: {
            200: SignupModel.sheetsResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: GroupModel.groupInvalid
        },
        detail: {
            summary: 'List a group\'s sign-up sheets',
            description:
                'The editor\'s view: every sheet, enabled or not, with both rank lists. What somebody can ' +
                'actually sign up for comes from GET /schedule/occurrences.'
        }
    })

    .get('/ranks', async ({ query, session }) => Signups.pickableRanks(query.groupId, session), {
        query: SignupModel.listRequest,
        response: {
            200: SignupModel.pickableRanksResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: GroupModel.groupInvalid
        },
        detail: {
            summary: 'Bound ranks, for a sheet\'s rank picker',
            description:
                'Served here rather than from /ranks so building a sheet does not need the grant that ' +
                'decides what every rank in the group may do.'
        }
    })

    .post('/', async ({ body, session }) => Signups.create(body, session), {
        body: SignupModel.createBody,
        response: {
            200: SignupModel.createResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: GroupModel.groupInvalid
        },
        detail: { summary: 'Create a sign-up sheet' }
    })

    .group('/:sheetId', (app) =>
        app
            .get('/', async ({ params: { sheetId }, session }) => Signups.get(sheetId, session), {
                params: t.Object({ sheetId: t.String({ format: 'uuid' }) }),
                response: {
                    200: SignupModel.sheetResponse,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: SignupModel.sheetInvalid
                },
                detail: { summary: 'Read one sign-up sheet' }
            })

            .patch('/', async ({ params: { sheetId }, body, session }) => Signups.update(sheetId, body, session), {
                params: t.Object({ sheetId: t.String({ format: 'uuid' }) }),
                body: SignupModel.updateBody,
                response: {
                    200: SignupModel.sheetResponse,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: SignupModel.sheetInvalid
                },
                detail: {
                    summary: 'Update a sign-up sheet',
                    description:
                        'Sending `rankIds` replaces the sheet\'s rank list wholesale. An empty list means ' +
                        'every member of the group.'
                }
            })

            .put('/slots', async ({ params: { sheetId }, body, session }) => Signups.setSlots(sheetId, body, session), {
                params: t.Object({ sheetId: t.String({ format: 'uuid' }) }),
                body: SignupModel.slotsBody,
                response: {
                    200: SignupModel.sheetResponse,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: SignupModel.sheetInvalid
                },
                detail: {
                    summary: 'Replace a sheet\'s slots',
                    description:
                        'Rows whose name is unchanged are reused, so editing a sheet never drops sign-ups ' +
                        'already made against it.'
                }
            })

            .delete('/', async ({ params: { sheetId }, session }) => Signups.remove(sheetId, session), {
                params: t.Object({ sheetId: t.String({ format: 'uuid' }) }),
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: SignupModel.sheetInvalid
                },
                detail: { summary: 'Delete a sign-up sheet' }
            })
    )
