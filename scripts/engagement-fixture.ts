import { eq } from 'drizzle-orm'
import { readFile, writeFile } from 'node:fs/promises'
if (!process.env.DATABASE_URL?.endsWith('/trptools_engagement_test')) throw new Error('Use the isolated test database')
const { default: db, client } = await import('../src/db')
const { users, groups, sessions, events, signupSheets, signupSlots, shiftSignups, groupFollows, routes, routePreferences, statisticsDaily, notificationWatches } = await import('../src/db/schema')
const { hashToken } = await import('../src/utils/sessionVerifier')
const path = '/tmp/trptools-engagement-fixture.json'
if (process.argv.includes('--refresh')) {
    const fixture = JSON.parse(await readFile(path, 'utf8')); const start = new Date(Math.floor((Date.now() + 40 * 60_000) / 1000) * 1000)
    await db.update(events).set({ startTime: start, notificationAt: new Date() }).where(eq(events.eventId, fixture.eventId))
    await db.update(shiftSignups).set({ occurrence: start }).where(eq(shiftSignups.eventId, fixture.eventId))
    await writeFile(path, JSON.stringify({ ...fixture, start: start.toISOString() }))
} else if (process.argv.includes('--clean')) {
    const fixture = JSON.parse(await readFile(path, 'utf8'))
    for (const id of fixture.groupIds) await db.delete(groups).where(eq(groups.id, id))
    for (const id of fixture.userIds) await db.delete(users).where(eq(users.id, id))
} else {
    const userIds = Array.from({ length: 6 }, () => crypto.randomUUID()), groupIds = Array.from({ length: 2 }, () => crypto.randomUUID())
    const token = crypto.randomUUID(), userId = userIds[0]!, groupId = groupIds[0]!, eventId = crypto.randomUUID(), slotId = crypto.randomUUID(), sheetId = crypto.randomUUID(), routeId = crypto.randomUUID()
    const now = new Date(), start = new Date(Math.floor((Date.now() + 5 * 60_000) / 1000) * 1000)
    await db.insert(users).values(userIds.map((id, i) => ({ id, robloxId: 8_000_000_000 + Date.now() + i, cachedAt: now, cachedUsername: i ? 'driver' + i : 'engagementreview', cachedDisplayName: i ? 'Driver ' + i : 'Luna', siteRank: i ? 'user' : 'admin', timezone: 'America/Phoenix', locale: 'en' })))
    await db.insert(sessions).values({ sessionId: hashToken(token), userId, adminMode: true, expiresAt: new Date(Date.now() + 86400_000) })
    await db.insert(groups).values(groupIds.map((id, i) => ({ id, robloxId: String(7_000_000_000 + Date.now() + i), slug: i ? 'engagement-cat-island' : 'engagement-north', name: i ? 'Cat Island Transit' : 'North Island Transit', cachedName: i ? 'Cat Island Transit' : 'North Island Transit', tagline: i ? 'Your connection across the island.' : 'A friendly service, every evening.', about: 'Regular routes, welcoming drivers and a place for everyone.', visibility: 'PUBLIC', cachedAt: now, cachedMembers: i ? 320 : 1250, discordInvite: 'https://discord.gg/test-fixture', accentColor: i ? '#e39648' : '#5e88ea' })))
    await db.insert(groupFollows).values(groupIds.map(groupId => ({ groupId, userId })))
    await db.insert(events).values([{ eventId, groupId, name: 'Evening island service', slug: 'evening-service', startTime: start, rrule: 'FREQ=DAILY;COUNT=14', duration: 120 }, { groupId: groupIds[1]!, name: 'Cat Island connections', slug: 'cat-connections', startTime: new Date(start.getTime() + 3600_000), rrule: 'FREQ=DAILY;COUNT=14', duration: 90 }])
    await db.insert(signupSheets).values({ id: sheetId, groupId, name: 'Drivers', enabled: true })
    await db.insert(signupSlots).values({ id: slotId, sheetId, name: 'Trolleybus driver', capacity: 4 })
    await db.insert(shiftSignups).values({ eventId, slotId, userId, occurrence: start })
    await db.insert(routes).values([{ id: routeId, groupId, name: '15', slug: '15', color: '#dd739f', description: 'The coastal connection.' }, { groupId, name: '10', slug: '10', builtIn: true, color: '#668bcc' }])
    await db.insert(routePreferences).values(userIds.slice(1).map((userId, i) => ({ userId, routeId, preference: i < 3 ? 'FAVORITE' as const : 'DISLIKE' as const })))
    await db.insert(statisticsDaily).values(Array.from({ length: 14 }, (_, i) => ({ groupId, day: new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), kind: 'group_view', targetId: groupId, count: 10 + i * 3 })))
    await db.insert(statisticsDaily).values(['join_view_discord', 'join_click_discord', 'join_view_roblox', 'join_click_roblox'].map((kind, i) => ({ groupId, day: now.toISOString().slice(0, 10), kind, targetId: groupId, count: [100, 65, 80, 40][i]! })))
    await writeFile(path, JSON.stringify({ token, groupIds, userIds, groupId, userId, eventId, start: start.toISOString(), routeId, groupSlug: 'engagement-north' }))
    console.log('Isolated engagement visual fixture created.')
}
await client?.end()
