import { Elysia, t } from 'elysia'
import { sessionPlugin, requireUser } from '../utils/authPlugin'
import { globalModel } from '../utils/globalModel'
import { rateLimit } from '../utils/ratelimit'
import { Claimables } from './service'
import { ClaimableModel } from './model'
const groupQuery = t.Object({ groupId: t.String() })
const params = t.Object({ claimId: t.String({ format: 'uuid' }) })
const errors = { 400: ClaimableModel.invalid, 401: globalModel.unauthorized, 403: t.Union([globalModel.forbidden, ClaimableModel.ineligible, ClaimableModel.unsafe]),
    404: t.Union([globalModel.notFound, ClaimableModel.invalid]), 409: globalModel.conflict,
    429: globalModel.rateLimited, 503: t.Union([ClaimableModel.unavailable, ClaimableModel.rejected]) }
export const claimables = new Elysia({ prefix: '/claimables', tags: ['Claimable ranks'] })
    .use(sessionPlugin)
    .onAfterHandle(({ set }) => { set.headers['cache-control'] = 'private, no-store' })
    .get('/', ({ query, session }) => Claimables.list(query.groupId, session), { query: groupQuery, response: { 200: ClaimableModel.list, ...errors } })
    .post('/', ({ body, session }) => Claimables.create(body, session), { body: ClaimableModel.create, response: { 200: ClaimableModel.item, ...errors } })
    .get('/ranks', ({ query, session }) => Claimables.ranks(query.groupId, session), { query: groupQuery, response: { 200: ClaimableModel.ranks, ...errors } })
    .get('/connection', ({ query, session }) => Claimables.connection(query.groupId, session), { query: groupQuery, response: { 200: ClaimableModel.connection, ...errors } })
    .post('/connection', ({ body, session }) => Claimables.connect(body.groupId, session), { body: groupQuery, response: { 200: globalModel.genericSuccess, ...errors } })
    .delete('/connection', ({ query, session }) => Claimables.disconnect(query.groupId, session), { query: groupQuery, response: { 200: globalModel.genericSuccess, ...errors } })
    .get('/:claimId', ({ params, session }) => Claimables.get(params.claimId, session), { params, response: { 200: ClaimableModel.item, ...errors } })
    .patch('/:claimId', ({ params, body, session }) => Claimables.patch(params.claimId, body, session), { params, body: ClaimableModel.patch, response: { 200: ClaimableModel.item, ...errors } })
    .delete('/:claimId', ({ params, session }) => Claimables.remove(params.claimId, session), { params, response: { 200: globalModel.genericSuccess, ...errors } })
    .get('/:claimId/me', ({ params, session }) => Claimables.inspect(params.claimId, session), { params, response: { 200: ClaimableModel.standing, ...errors } })
    .post('/:claimId/claim', async ({ params, session }) => {
        await rateLimit('claimable:claim', requireUser(session).userId, 5, 60)
        return Claimables.claim(params.claimId, session)
    }, { params, response: { 200: ClaimableModel.result, ...errors } })
    .get('/:claimId/status', async ({ params, session }) => {
        await rateLimit('claimable:status', requireUser(session).userId, 25, 60)
        return Claimables.confirm(params.claimId, session)
    }, { params, response: { 200: ClaimableModel.result, ...errors } })
