import { beforeEach, expect, mock, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { PERM, levelForPermissions } from '../src/utils/permissions'
import type { Group, Event } from '../src/db/schema'
import type { session } from '../src/utils/sessionVerifier'

// Run this isolated suite separately from src tests: only the external I/O is
// replaced, so the actual membership, visibility and summary rules are exercised.
const group = {
    id: '00000000-0000-4000-8000-000000000002', robloxId: '123', slug: 'test-group',
    name: null, cachedName: 'Test Group', cachedAt: new Date(), cachedIcon: null,
    cachedDescription: '', cachedMembers: 10, visibility: 'PUBLIC', tagline: '', about: '',
    sourceLocale: 'en', translations: {}, accentColor: '#4287f5', bannerMediaId: null,
    createdAt: new Date(), showRoutes: true, showShifts: true, showRoster: false, showDispatch: true,
    signupLeadMinutes: 1440, roomOpenLeadMinutes: 10, openCloudKey: null,
    requireDiscordForSignups: false, requireDiscordForApplications: false, moderation: 'VISIBLE'
} as Group
const start = new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000)
const event = {
    eventId: 'event-one', groupId: group.id, name: 'Member Shift', slug: 'member-shift',
    translations: {}, color: '#4287f5', startTime: start, rrule: 'FREQ=DAILY;COUNT=1',
    duration: 120, visibility: 'PRIVATE'
} as Event
const viewer: session = {
    authenticated: true,
    user: { userId: 'viewer', robloxId: 10, siteRank: 'user', adminMode: false }
}
let grants = PERM.VIEW_DASHBOARD
let rank = 5
const queries: string[] = []
let redisReads = 0

mock.module('../src/db', () => ({ default: {
    select(fields?: Record<string, unknown>) {
        let table = ''
        const rows = () => {
            queries.push(table)
            switch (table) {
                case 'groups':
                    if (fields) throw new Error('Unexpected group credentials read')
                    return [group]
                case 'routes': return [{ id: 'route', name: '10', translations: {}, color: '#ffffff', textColor: '#000000', shape: 'RECTANGLE', iconMediaId: 'hidden-icon' }]
                case 'depots': return []
                case 'events': return [{ event, visibility: group.visibility, showShifts: group.showShifts, leadMinutes: group.signupLeadMinutes }]
                case 'signup_sheets': return [
                    { groupId: group.id, slotId: 'driver', capacity: 3, rankId: 'driver-rank' },
                    { groupId: group.id, slotId: 'dispatcher', capacity: 5, rankId: 'dispatcher-rank' }
                ]
                case 'shift_signups': return [
                    { eventId: event.eventId, occurrence: start, slotId: 'driver', filled: 1, signedUp: true },
                    { eventId: event.eventId, occurrence: start, slotId: 'dispatcher', filled: 4, signedUp: false }
                ]
                case 'media': return [{ id: 'hidden-icon', key: 'hidden.png', moderation: 'HIDDEN' }]
                case 'rank_relations': return [{ groupId: group.id, id: 'driver-rank', permissions: grants, cachedRank: rank }]
                case 'application_submissions': return [{
                    id: 'submission', applicationId: 'application', applicationName: 'Driver Application',
                    applicationTranslations: {}, color: '#fff', rankName: 'Driver', submittedAt: start,
                    userId: 'applicant', robloxId: 20, username: 'Applicant', displayName: 'Applicant', avatar: null
                }]
                default: throw new Error(`Unexpected DB read: ${table}`)
            }
        }
        const query = {
            from(value: Parameters<typeof getTableName>[0]) { table = getTableName(value); return this },
            where() { return this }, innerJoin() { return this }, leftJoin() { return this },
            orderBy() { return this }, groupBy() { return this }, limit() { return this },
            then(resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
                return Promise.resolve().then(rows).then(resolve, reject)
            }
        }
        return query
    }
} }))
mock.module('../src/utils/redis', () => ({
    dataRedis: {
        async mget(keys: string[]) {
            redisReads++
            return keys.map((key) => key.startsWith('perm:')
                ? `${levelForPermissions(grants)}:${rank}:${grants}:driver-rank` : 'live-room')
        }
    }, deleteByPattern: async () => {}, deleteByPrefix: async () => {}, subscribeChannel: async () => () => {}
}))
mock.module('../src/utils/roblox', () => ({ Roblox: {
    getUserGroups: async () => [{ groupId: 123, role: { id: 1, rank: 5 } }]
} }))

const { groupOverview } = await import('../src/dashboard/group')
const { Dashboard } = await import('../src/dashboard/service')
const { DashboardModel } = await import('../src/dashboard/model')

beforeEach(() => {
    grants = PERM.VIEW_DASHBOARD
    rank = 5
    group.visibility = 'PUBLIC'
    group.showShifts = true
    queries.length = 0
    redisReads = 0
})

test('overview counts only visible slots and omits hidden media and reviewer data', async () => {
    const result = await groupOverview(group.slug, viewer)
    expect(result.overview.upcoming[0]).toMatchObject({ capacity: 3, filled: 1, signedUp: true })
    expect(result.overview.routes[0].icon).toBeNull()
    expect(result.overview.applicants).toEqual([])
    expect(result.overview.openRoomId).toBeNull()
    expect(result.overview.shiftCount).toBe(1)
    expect(redisReads).toBe(1)
    expect([...queries].sort()).toEqual(['groups', 'routes', 'depots', 'events', 'signup_sheets', 'shift_signups', 'media'].sort())
})

test('dispatch and review grants independently unlock their overview data', async () => {
    grants |= PERM.DISPATCH | PERM.REVIEW_APPLICATIONS
    const result = await groupOverview(group.id, viewer)
    expect(result.overview.openRoomId).toBe('live-room')
    expect(result.overview.applicants[0].applicant.userId).toBe('applicant')
    expect(result.overview.upcoming[0].capacity).toBe(3)
})

test('admin account without admin mode has no bypass', async () => {
    grants = 0
    const admin = { ...viewer, user: { ...viewer.user!, siteRank: 'admin' } }
    await expect(groupOverview(group.slug, admin)).rejects.toMatchObject({ code: 403 })
    group.visibility = 'PRIVATE'
    await expect(groupOverview(group.slug, admin)).rejects.toMatchObject({ code: 404 })
    expect(queries).toEqual(['groups', 'groups'])
})

test('elevated admin sees the full authorized summary', async () => {
    grants = 0
    const result = await groupOverview(group.slug, { ...viewer, user: { ...viewer.user!, siteRank: 'admin', adminMode: true } })
    expect(result.overview.upcoming[0]).toMatchObject({ capacity: 8, filled: 5 })
    expect(result.overview.applicants).toHaveLength(1)
    expect(result.overview.openRoomId).toBe('live-room')
})

test('global shifts includes ordinary drivers even with no dashboard grants', async () => {
    grants = 0
    const result = await Dashboard.shifts(viewer)
    expect(result.groups[0].permissionLevel).toBe(0)
    expect(result.occurrences[0]).toMatchObject({ name: 'Member Shift', capacity: 3, filled: 1 })
    expect(redisReads).toBe(1)
    expect(queries.filter((table) => table === 'events')).toHaveLength(1)
})

test('group discovery cannot authorize a departed member to read private shifts', async () => {
    grants = 0
    rank = -1
    group.visibility = 'PRIVATE'
    const result = await Dashboard.shifts(viewer)
    expect(result.occurrences).toEqual([])
    expect(queries).not.toContain('signup_sheets')
})

test('anonymous overview and global shifts do not access storage', async () => {
    await expect(groupOverview(group.slug, { authenticated: false })).rejects.toMatchObject({ code: 401 })
    await expect(Dashboard.shifts({ authenticated: false })).rejects.toMatchObject({ code: 401 })
    expect(queries).toEqual([])
    expect(redisReads).toBe(0)
})

test('lazy renderer still produces PNGs on concurrent first use', async () => {
    const { renderManifest } = await import('../src/bot/manifest')
    const data = { groupName: 'Test Group', shiftName: 'Member Shift', vehicles: [], drivers: new Map<string, string>(), dispatchers: 1, renderedAt: start }
    const images = await Promise.all([renderManifest(data), renderManifest(data)])
    for (const png of images) expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
})

test('overview payload passes the HTTP response schema and serializes dates', async () => {
    const app = new Elysia().get('/summary', () => groupOverview(group.slug, viewer), { response: DashboardModel.groupPageData })
    const response = await app.handle(new Request('http://localhost/summary'))
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.overview.upcoming[0].start).toBe(start.toISOString())
    expect(payload.group.moderation).toBe('VISIBLE')
})
