import { Elysia } from 'elysia'
import { sessionPlugin } from '../utils/authPlugin'
import { globalModel } from '../utils/globalModel'
import { DriverModel } from './model'
import { Driver } from './service'

/**
 * The driver's side of dispatch: what the open rooms are telling the
 * caller's own vehicles. An API key reaches it with `driver:read`, which is
 * its own scope and part of no other, so an in-game companion or a Discord
 * integration can follow one person's instructions without being able to
 * read a board.
 */
export const driver = new Elysia({ prefix: '/driver', tags: ['Driver'] })
    .use(sessionPlugin)
    .get('/me', async ({ session }) => Driver.mine(session), {
        response: { 200: DriverModel.response, 401: globalModel.unauthorized },
        detail: {
            summary: 'What dispatch is telling your vehicles',
            description:
                'Every vehicle you own on an open dispatch board, in any group: the route or written note it was ' +
                'given, who it tows or is towed by, the last stop, continue or end-of-shift order, and whether ' +
                'the host has sent drivers back to their depot. `stateIndex` changes whenever any of that changes, ' +
                'so a client can poll and act only on a new value. Matched by the Roblox account you signed in with.'
        }
    })
