import { describe, expect, test } from 'bun:test'
import {
    channelPermissions,
    guildPermissions,
    has,
    PERMISSIONS,
    type DiscordChannel,
    type DiscordRole
} from './discord'

/**
 * Discord never reports what a bot may do in a channel, so `channelPermissions`
 * reimplements its algorithm. Getting the order wrong reports a channel as
 * writable when it is not, which is precisely the failure the dashboard's
 * red and green dots exist to prevent — so the ordering rules are pinned here
 * rather than trusted.
 */

const GUILD = '100'
const BOT = '999'

const role = (id: string, permissions: bigint, position = 1): DiscordRole => ({
    id,
    name: `role-${id}`,
    color: 0,
    position,
    permissions: permissions.toString(),
    managed: false,
    mentionable: true
})

const VIEW = PERMISSIONS.VIEW_CHANNEL
const SEND = PERMISSIONS.SEND_MESSAGES

const channel = (overwrites: DiscordChannel['permission_overwrites'] = []): DiscordChannel => ({
    id: 'c1',
    type: 0,
    name: 'general',
    permission_overwrites: overwrites
})

describe('guildPermissions', () => {
    test('unions @everyone with the roles the member holds', () => {
        const roles = [role(GUILD, VIEW, 0), role('r1', SEND)]
        const permissions = guildPermissions(roles, ['r1'], GUILD)

        expect(has(permissions, 'VIEW_CHANNEL')).toBe(true)
        expect(has(permissions, 'SEND_MESSAGES')).toBe(true)
    })

    test('ignores roles the member does not hold', () => {
        const roles = [role(GUILD, VIEW, 0), role('r1', SEND)]
        expect(has(guildPermissions(roles, [], GUILD), 'SEND_MESSAGES')).toBe(false)
    })

    test('administrator grants everything', () => {
        const roles = [role(GUILD, 0n, 0), role('r1', PERMISSIONS.ADMINISTRATOR)]
        const permissions = guildPermissions(roles, ['r1'], GUILD)

        expect(has(permissions, 'SEND_POLLS')).toBe(true)
        expect(has(permissions, 'MANAGE_MESSAGES')).toBe(true)
    })
})

describe('channelPermissions', () => {
    const roles = [role(GUILD, VIEW | SEND, 0), role('r1', 0n)]

    test('inherits guild permissions with no overwrites', () => {
        const permissions = channelPermissions(channel(), roles, ['r1'], GUILD, BOT)
        expect(has(permissions, 'SEND_MESSAGES')).toBe(true)
    })

    test('an @everyone deny removes the permission', () => {
        const permissions = channelPermissions(
            channel([{ id: GUILD, type: 0, allow: '0', deny: SEND.toString() }]),
            roles,
            ['r1'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'VIEW_CHANNEL')).toBe(true)
        expect(has(permissions, 'SEND_MESSAGES')).toBe(false)
    })

    test('a role allow beats an @everyone deny', () => {
        const permissions = channelPermissions(
            channel([
                { id: GUILD, type: 0, allow: '0', deny: SEND.toString() },
                { id: 'r1', type: 0, allow: SEND.toString(), deny: '0' }
            ]),
            roles,
            ['r1'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'SEND_MESSAGES')).toBe(true)
    })

    test('an allow on one held role beats a deny on another', () => {
        // Role overwrites accumulate before being applied. Applying them one
        // at a time would let whichever came last decide.
        const twoRoles = [role(GUILD, VIEW | SEND, 0), role('r1', 0n), role('r2', 0n)]

        const permissions = channelPermissions(
            channel([
                { id: 'r1', type: 0, allow: '0', deny: SEND.toString() },
                { id: 'r2', type: 0, allow: SEND.toString(), deny: '0' }
            ]),
            twoRoles,
            ['r1', 'r2'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'SEND_MESSAGES')).toBe(true)
    })

    test('a member overwrite beats every role overwrite', () => {
        const permissions = channelPermissions(
            channel([
                { id: 'r1', type: 0, allow: SEND.toString(), deny: '0' },
                { id: BOT, type: 1, allow: '0', deny: SEND.toString() }
            ]),
            roles,
            ['r1'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'SEND_MESSAGES')).toBe(false)
    })

    test('a member overwrite for somebody else is ignored', () => {
        const permissions = channelPermissions(
            channel([{ id: 'someone-else', type: 1, allow: '0', deny: SEND.toString() }]),
            roles,
            ['r1'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'SEND_MESSAGES')).toBe(true)
    })

    test('administrator ignores channel overwrites entirely', () => {
        const adminRoles = [role(GUILD, 0n, 0), role('r1', PERMISSIONS.ADMINISTRATOR)]

        const permissions = channelPermissions(
            channel([{ id: GUILD, type: 0, allow: '0', deny: (VIEW | SEND).toString() }]),
            adminRoles,
            ['r1'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'VIEW_CHANNEL')).toBe(true)
        expect(has(permissions, 'SEND_MESSAGES')).toBe(true)
    })

    test('a denied view leaves the channel unreadable', () => {
        const permissions = channelPermissions(
            channel([{ id: GUILD, type: 0, allow: '0', deny: VIEW.toString() }]),
            roles,
            ['r1'],
            GUILD,
            BOT
        )

        expect(has(permissions, 'VIEW_CHANNEL')).toBe(false)
    })

    test('permissions beyond 2^31 survive the maths', () => {
        // SEND_POLLS is bit 49. Doing any of this in a JS number would lose it.
        const pollRoles = [role(GUILD, PERMISSIONS.SEND_POLLS, 0)]
        const permissions = channelPermissions(channel(), pollRoles, [], GUILD, BOT)

        expect(has(permissions, 'SEND_POLLS')).toBe(true)
    })
})
