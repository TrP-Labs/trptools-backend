import { Elysia, t } from 'elysia'
import { sessionPlugin } from '../utils/authPlugin'
import { HostModel } from './model'
import { Host } from './service'

export const host = new Elysia({ prefix: '/host', tags: ['Host'] }).use(sessionPlugin)
    .get('/schedule/:groupId', ({ params, session }) => Host.schedule(params.groupId, session), { response: { 200: HostModel.schedule } })
    .put('/schedule/:groupId', ({ params, body, session }) => Host.saveSchedule(params.groupId, body, session), { body: HostModel.schedule })
    .get('/:roomId', ({ params, session }) => Host.get(params.roomId, session), { response: { 200: HostModel.snapshot } })
    .post('/:roomId/extend', ({ params, body, session }) => Host.extend(params.roomId, body.minutes, session), {
        body: t.Object({ minutes: t.Union([t.Literal(5), t.Literal(10), t.Literal(30), t.Literal(60)]) }), response: { 200: HostModel.snapshot }
    })
    .post('/:roomId/events/:id', ({ params, body, session }) => Host.event(params.roomId, params.id, body, session), {
        body: HostModel.eventBody, response: { 200: HostModel.snapshot }
    })
    .put('/:roomId/note', ({ params, body, session }) => Host.note(params.roomId, body, session), { body: HostModel.noteBody, response: { 200: HostModel.snapshot } })
