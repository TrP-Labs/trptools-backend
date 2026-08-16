/**
 * Development seed.
 *
 * Roblox OAuth needs registered credentials and a browser round trip, which
 * makes it awkward to work on the dispatch and scheduling screens locally.
 * This inserts a believable group, a signed-in session and enough routes and
 * shifts to exercise every screen.
 *
 *   bun run db:seed
 *
 * It prints a session token to paste into an `access_token` cookie.
 */

import { eq } from 'drizzle-orm'
import { RRule } from 'rrule'
import db, { client } from '../db'
import {
    depots,
    events,
    groups,
    rankRelations,
    rankSignups,
    rankSignupSlots,
    routeDepots,
    routes,
    sessions,
    users,
    vehicleRules
} from '../db/schema'
import { generateSessionToken, hashToken } from '../utils/sessionVerifier'
import { seedGroupDefaults } from '../groups/defaults'
import { childSlug } from '../utils/slug'
import { env } from '../utils/env'

if (env.isProduction) {
    console.error('Refusing to seed a production database.')
    process.exit(1)
}

const DEMO_ROBLOX_USER = 1
const DEMO_ROBLOX_GROUP = '35019352'

async function seed() {
    console.log('Seeding development data...')

    const [user] = await db
        .insert(users)
        .values({
            robloxId: DEMO_ROBLOX_USER,
            siteRank: 'admin',
            cachedUsername: 'Roblox',
            cachedDisplayName: 'Roblox',
            cachedAt: new Date()
        })
        .onConflictDoUpdate({ target: users.robloxId, set: { siteRank: 'admin' } })
        .returning()

    if (!user) throw new Error('could not create demo user')

    const [group] = await db
        .insert(groups)
        .values({
            robloxId: DEMO_ROBLOX_GROUP,
            slug: 'demo-transit',
            visibility: 'PUBLIC',
            tagline: 'A demonstration transit operator',
            about:
                'This group exists so the dashboard, public pages and dispatch room can be worked on without Roblox credentials.',
            accentColor: '#4287f5',
            cachedName: 'Demo Transit Authority',
            cachedDescription: 'Seeded group for local development.',
            cachedMembers: 1234,
            cachedAt: new Date()
        })
        .onConflictDoUpdate({ target: groups.robloxId, set: { cachedAt: new Date(), showRoster: true } })
        .returning()

    if (!group) throw new Error('could not create demo group')

    // Wipe the group's child rows so reseeding is idempotent.
    await db.delete(routes).where(eq(routes.groupId, group.id))
    await db.delete(depots).where(eq(depots.groupId, group.id))
    await db.delete(events).where(eq(events.groupId, group.id))
    await db.delete(vehicleRules).where(eq(vehicleRules.groupId, group.id))
    await db.delete(rankRelations).where(eq(rankRelations.groupId, group.id))

    // Real Roblox role ids for the demo group, so the public roster actually
    // resolves members instead of coming back empty.
    const seededRanks = await db
        .insert(rankRelations)
        .values([
            {
                groupId: group.id,
                robloxId: '166926003',
                cachedName: 'Owner',
                cachedRank: 255,
                permissionLevel: 3,
                visible: true,
                color: '#9b59b6',
                description: 'Runs the group and holds every permission.'
            },
            {
                groupId: group.id,
                robloxId: '167114006',
                cachedName: 'Admin',
                cachedRank: 254,
                permissionLevel: 2,
                visible: true,
                color: '#4287f5',
                description: 'Opens shifts and assigns routes during dispatch.'
            },
            {
                groupId: group.id,
                robloxId: '12884901889',
                cachedName: 'Member',
                cachedRank: 1,
                permissionLevel: 1,
                visible: true,
                color: '#3fb950',
                description: 'Drives assigned routes on shift.'
            }
        ])
        .returning({ id: rankRelations.id, cachedRank: rankRelations.cachedRank })

    // Two sheets at different ranks, so the gating is visible immediately:
    // a member sees only the driver sheet, an admin sees both.
    const adminRank = seededRanks.find((rank) => rank.cachedRank === 254)
    const memberRank = seededRanks.find((rank) => rank.cachedRank === 1)

    if (adminRank) {
        const [sheet] = await db
            .insert(rankSignups)
            .values({
                rankId: adminRank.id,
                enabled: true,
                name: 'Shift team',
                description: 'Runs the shift from the dispatch room.',
                color: '#4287f5'
            })
            .returning({ id: rankSignups.id })

        if (sheet) {
            await db.insert(rankSignupSlots).values([
                { signupId: sheet.id, name: 'Host', description: 'Opens the room and the server', capacity: 1, order: 0 },
                { signupId: sheet.id, name: 'Dispatcher', description: 'Assigns routes', capacity: 2, order: 1 }
            ])
        }
    }

    if (memberRank) {
        const [sheet] = await db
            .insert(rankSignups)
            .values({
                rankId: memberRank.id,
                enabled: true,
                name: 'Drivers',
                description: 'Drives an assigned route.',
                color: '#3fb950'
            })
            .returning({ id: rankSignups.id })

        if (sheet) {
            await db.insert(rankSignupSlots).values([
                { signupId: sheet.id, name: 'Driver', description: 'Drives an assigned route', capacity: 12, order: 0 },
                { signupId: sheet.id, name: 'Reserve', description: 'Fills in as needed', capacity: 4, order: 1 }
            ])
        }
    }

    // Every group gets the game's own depots and routes.
    await seedGroupDefaults(group.id)

    const groupDepots = await db.select().from(depots).where(eq(depots.groupId, group.id))
    const main = groupDepots.find((depot) => depot.number === 1)

    // A couple of custom routes, to show they sit alongside the built-ins.
    const customRoutes = [
        { name: 'EXPRESS', color: '#e0559a', shape: 'RECTANGLE' as const, share: 15, depots: [] as string[] },
        {
            name: 'NIGHT',
            color: '#5865f2',
            shape: 'DIAMOND' as const,
            share: 10,
            depots: [main?.id].filter((id): id is string => Boolean(id))
        }
    ]

    for (const [index, custom] of customRoutes.entries()) {
        const [created] = await db
            .insert(routes)
            .values({
                groupId: group.id,
                name: custom.name,
                slug: childSlug('route', custom.name, index + 1),
                description: `Seeded custom route ${custom.name}.`,
                color: custom.color,
                shape: custom.shape,
                targetShare: custom.share,
                order: 10 + index,
                visibility: 'PUBLIC'
            })
            .returning({ id: routes.id })

        if (created && custom.depots.length > 0) {
            await db.insert(routeDepots).values(custom.depots.map((depotId) => ({ routeId: created.id, depotId })))
        }
    }

    // The legacy dispatcher hardcoded these two overrides; here they are data.
    await db.insert(vehicleRules).values([
        { groupId: group.id, pattern: 'ZiU-682 \\(ZiU-9\\) Service vehicle', category: 'SERVICE', fixedRoute: 'SV', order: 0 },
        { groupId: group.id, pattern: 'VAZ-2109 Sputnik', category: 'STAFF', fixedRoute: 'Staff', order: 1 },
        { groupId: group.id, pattern: 'service|tow|rescue', category: 'SERVICE', fixedRoute: null, order: 2 }
    ])

    // A shift that is running right now, so a dispatch room can be opened.
    const now = new Date()
    const startedAt = new Date(now.getTime() - 15 * 60 * 1000)

    const dailyRule = new RRule({
        freq: RRule.DAILY,
        dtstart: startedAt
    }).toString()

    await db
        .insert(events)
        .values({
            groupId: group.id,
            name: 'Daily Service',
            slug: 'daily-service',
            description: 'Runs every day. Seeded to be live right now so dispatch can be opened.',
            color: '#4287f5',
            startTime: startedAt,
            rrule: dailyRule,
            duration: 180,
            visibility: 'PUBLIC',
            hostLevel: 2
        })

    const weekendStart = new Date(now)
    weekendStart.setUTCHours(18, 0, 0, 0)

    await db
        .insert(events)
        .values({
            groupId: group.id,
            name: 'Weekend Rush',
            slug: 'weekend-rush',
            description: 'A busier weekend service with extra staffing.',
            color: '#e0559a',
            startTime: weekendStart,
            rrule: new RRule({
                freq: RRule.WEEKLY,
                byweekday: [RRule.SA, RRule.SU],
                dtstart: weekendStart
            }).toString(),
            duration: 240,
            visibility: 'PUBLIC',
            hostLevel: 2
        })

    const token = generateSessionToken()
    await db.insert(sessions).values({
        sessionId: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    })

    console.log('\nSeeded.')
    console.log(`  Group    ${group.cachedName} (/g/${group.slug})`)
    console.log(`  Group id ${group.id}`)
    console.log(`  User     ${user.cachedDisplayName} (${user.id})`)
    console.log('\nSign in locally by setting this cookie on the API origin:')
    console.log(`  access_token=${token}\n`)
    console.log('  document.cookie = "access_token=' + token + '; path=/"\n')
}

seed()
    .then(async () => {
        await client.end()
        process.exit(0)
    })
    .catch(async (error) => {
        console.error(error)
        await client.end()
        process.exit(1)
    })
