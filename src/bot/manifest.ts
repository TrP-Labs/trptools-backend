import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Resvg } from '@resvg/resvg-js'
import satori, { type SatoriOptions } from 'satori'
import interRegular from './assets/Inter-Regular.ttf' with { type: 'file' }
import interSemiBold from './assets/Inter-SemiBold.ttf' with { type: 'file' }
import db from '../db'
import { botConfigs, groups, users } from '../db/schema'
import { dataRedis } from '../utils/redis'
import { groupIndexKey, requireRoom, roomUsersKey } from '../rooms/service'
import { DispatchControls } from '../rooms/dispatch/service'
import { NOTE_ROUTE } from '../rooms/dispatch/solver'
import type { Vehicles } from '../rooms/dispatch/model'

/**
 * Renders the live dispatch board as a picture, for the Discord bot to post
 * under a shift's start announcement.
 *
 * Discord cannot show a live view, and an embed with forty vehicles in it
 * would be unreadable and would blow the field limit — so the board is drawn
 * the way the dispatch page draws it and sent as an image.
 *
 * It is rendered here rather than in the bot because everything needed is
 * already local: the room lives in this process's Redis, and route names and
 * colours in this process's database. Sending that down as JSON would mean
 * two copies of the same presentation logic drifting apart.
 *
 * satori draws to SVG and resvg rasterises it. Both are pure library code with
 * a bundled font, so this works in a container with no browser, no system
 * fonts and no filesystem to speak of — which is the deployment target.
 */

/**
 * The fonts, imported as assets rather than read by path.
 *
 * `new URL('./assets/…', import.meta.url)` was opaque to the bundler: it
 * copied nothing and still pointed beside the *source*, so a built image
 * looked for `dist/assets` and found nothing. An import attribute is something
 * the bundler understands — it emits the file next to the bundle and rewrites
 * the value.
 *
 * That value is absolute when running from `src` but bundle-relative when
 * built, and `Bun.file` would resolve the relative form against the process
 * working directory rather than against the bundle. Resolving it against
 * `import.meta.dir` is what makes both forms land on the real file.
 *
 * Loaded once; reading two fonts per render would dominate the render cost.
 */
const asset = (value: string) => resolve(import.meta.dir, value)

const fonts: Promise<SatoriOptions['fonts']> = Promise.all([
    Bun.file(asset(interRegular)).arrayBuffer(),
    Bun.file(asset(interSemiBold)).arrayBuffer()
]).then(([regular, semibold]) => [
    { name: 'Inter', data: regular, weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: semibold, weight: 600 as const, style: 'normal' as const }
])

const THEME = {
    background: '#0d1117',
    surface: '#161b22',
    border: '#30363d',
    text: '#e6edf3',
    muted: '#8b949e',
    accent: '#4287f5',
    unassigned: '#8b949e',
    number: '#21262d',
    tow: '#f0883e',
    note: '#a371f7'
}

/** Matches the lists the dispatch page draws, in the same order. */
const BUCKET_LABELS = {
    SERVICE: 'Service vehicles',
    STAFF: 'Staff vehicles',
    NORMAL: 'Vehicles',
    DECORATIVE: 'Decorative vehicles'
} as const

const BUCKET_ORDER = ['SERVICE', 'STAFF', 'NORMAL', 'DECORATIVE'] as const

type Bucket = (typeof BUCKET_ORDER)[number]

/** Scenery is owned by nobody, which is the only thing that marks it out. */
function bucketOf(vehicle: Vehicles.vehicle): Bucket {
    if (vehicle.ownerId === '0') return 'DECORATIVE'
    if (vehicle.category === 'SERVICE') return 'SERVICE'
    if (vehicle.category === 'STAFF') return 'STAFF'
    return 'NORMAL'
}

const STATUS_LABELS: Record<Vehicles.serviceStatus, string> = {
    AWAITING: 'Awaiting',
    ENROUTE: 'En route',
    ON_SCENE: 'On scene',
    RETURNING: 'Returning'
}

const STATUS_COLORS: Record<Vehicles.serviceStatus, string> = {
    AWAITING: '#8b949e',
    ENROUTE: '#f0883e',
    ON_SCENE: '#3fb950',
    RETURNING: '#4287f5'
}

const WIDTH = 1000
/** Two columns once a board grows past this, so tall shifts stay readable. */
const SINGLE_COLUMN_LIMIT = 14
const MAX_VEHICLES = 60

type Node = {
    type: string
    props: Record<string, unknown> & { children?: unknown }
}

const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
    type,
    props: { style, children }
})

const row = (style: Record<string, unknown>, children?: unknown) =>
    el('div', { display: 'flex', flexDirection: 'row', ...style }, children)

const column = (style: Record<string, unknown>, children?: unknown) =>
    el('div', { display: 'flex', flexDirection: 'column', ...style }, children)

const text = (value: string, style: Record<string, unknown>) => el('div', { display: 'flex', ...style }, value)

/** A coloured pill: a route badge, a service status, or a written note. */
function pill(label: string, background: string, color = '#0d1117', limit = 12) {
    return el(
        'div',
        {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 84,
            height: 26,
            borderRadius: 6,
            background,
            color,
            fontSize: 13,
            fontWeight: 600
        },
        label.slice(0, limit)
    )
}

/**
 * One vehicle line.
 *
 * The number leads, because it is what a dispatcher says out loud and what
 * everything else on the board — a tow, a call for a vehicle — refers back to.
 */
function vehicleRow(vehicle: Vehicles.vehicle, driver: string | null, towedBy: string | null) {
    const bucket = bucketOf(vehicle)

    const badge =
        bucket === 'SERVICE'
            ? pill(STATUS_LABELS[vehicle.status], STATUS_COLORS[vehicle.status])
            : vehicle.route === NOTE_ROUTE
              ? pill('Note', THEME.note)
              : vehicle.routeName
                ? pill(vehicle.routeName, vehicle.routeColor ?? THEME.unassigned)
                : pill(
                    bucket === 'NORMAL' ? 'Unassigned' : bucket === 'STAFF' ? 'Staff' : 'Scenery',
                    THEME.number,
                    THEME.muted
                )

    // The second line is whatever this vehicle's own kind makes it useful to
    // know: where a service vehicle is, what a note says, who is driving.
    const detail =
        bucket === 'SERVICE'
            ? vehicle.location || 'No location given'
            : // Scenery is owned by the game, so there is no driver to name.
              bucket === 'DECORATIVE'
              ? // "N/A" is what the game sends for a spawn outside a depot.
                (vehicle.depot && vehicle.depot !== 'N/A' ? vehicle.depot : 'Placed by the map')
              : vehicle.route === NOTE_ROUTE && vehicle.note
                ? vehicle.note
                : (driver ?? `Owner ${vehicle.ownerId}`)

    const tow = vehicle.towing
        ? `Towing ${vehicle.towing}`
        : towedBy
          ? `Towed by ${towedBy}`
          : null

    return row(
        {
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: THEME.surface,
            marginBottom: 6
        },
        [
            el(
                'div',
                {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 52,
                    height: 26,
                    borderRadius: 6,
                    background: THEME.number,
                    color: THEME.text,
                    fontSize: 14,
                    fontWeight: 600
                },
                vehicle.id.slice(0, 6)
            ),
            badge,
            column({ flexGrow: 1, minWidth: 0 }, [
                text(vehicle.name.slice(0, 34), { fontSize: 14, color: THEME.text }),
                text(detail.slice(0, 40), { fontSize: 12, color: THEME.muted })
            ]),
            tow ? pill(tow, THEME.number, THEME.tow, 20) : null,
            vehicle.assigned ? text('✓', { fontSize: 15, color: '#3fb950', fontWeight: 600 }) : null
        ].filter(Boolean)
    )
}

/** The heading above each list, so the board reads like the dispatch page. */
function sectionHeader(bucket: Bucket, count: number) {
    return row({ alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 6 }, [
        text(BUCKET_LABELS[bucket].toUpperCase(), {
            fontSize: 11,
            fontWeight: 600,
            color: THEME.muted
        }),
        text(String(count), { fontSize: 11, color: THEME.border })
    ])
}

function statTile(label: string, value: string) {
    return column(
        {
            flexGrow: 1,
            padding: '10px 14px',
            borderRadius: 8,
            background: THEME.surface,
            border: `1px solid ${THEME.border}`
        },
        [
            text(value, { fontSize: 22, fontWeight: 600, color: THEME.text }),
            text(label, { fontSize: 12, color: THEME.muted })
        ]
    )
}

export type ManifestData = {
    groupName: string
    shiftName: string
    vehicles: Vehicles.vehicle[]
    drivers: Map<string, string>
    dispatchers: number
    renderedAt: Date
}

function board(data: ManifestData): Node {
    // Ordered the way the dispatch page orders its lists, so somebody looking
    // at both is looking at the same board.
    const ordered = BUCKET_ORDER.flatMap((bucket) =>
        data.vehicles
            .filter((vehicle) => bucketOf(vehicle) === bucket)
            .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    )

    const shown = ordered.slice(0, MAX_VEHICLES)

    // Who is towing whom, read off the tow trucks. The towed vehicle carries
    // no record of it, so this is the only place the other half comes from.
    const towedBy = new Map<string, string>()
    for (const vehicle of data.vehicles) {
        if (vehicle.towing) towedBy.set(vehicle.towing, vehicle.id)
    }

    // Two different things, and conflating them misreports a freshly solved
    // board as empty: `routeName` is what the solver decided, while `assigned`
    // is the dispatcher's own tick that they have told the driver.
    //
    // Both are measured against the vehicles that can actually take a route —
    // counting service vans and scenery in the denominator makes a fully
    // solved shift look half done.
    const passenger = data.vehicles.filter((vehicle) => bucketOf(vehicle) === 'NORMAL')
    const routed = passenger.filter((vehicle) => vehicle.routeName && vehicle.route !== NOTE_ROUTE).length
    const confirmed = passenger.filter((vehicle) => vehicle.assigned).length

    // Only real routes are counted here — a service vehicle carries the
    // literal label "SV", which is not a route anybody is busiest on.
    const routeCounts = new Map<string, number>()
    for (const vehicle of shown) {
        if (!vehicle.routeName || !vehicle.routeColor) continue
        routeCounts.set(vehicle.routeName, (routeCounts.get(vehicle.routeName) ?? 0) + 1)
    }

    const busiest = [...routeCounts.entries()].sort((a, b) => b[1] - a[1])[0]

    const twoColumn = shown.length > SINGLE_COLUMN_LIMIT

    const rows: Node[] = []
    for (const bucket of BUCKET_ORDER) {
        const inBucket = shown.filter((vehicle) => bucketOf(vehicle) === bucket)
        if (inBucket.length === 0) continue

        rows.push(sectionHeader(bucket, inBucket.length))
        for (const vehicle of inBucket) {
            rows.push(
                vehicleRow(vehicle, data.drivers.get(vehicle.ownerId) ?? null, towedBy.get(vehicle.id) ?? null)
            )
        }
    }

    const half = Math.ceil(rows.length / 2)

    const body = twoColumn
        ? row({ gap: 12 }, [
              column({ width: (WIDTH - 72) / 2 }, rows.slice(0, half)),
              column({ width: (WIDTH - 72) / 2 }, rows.slice(half))
          ])
        : column({}, rows)

    return column(
        {
            width: WIDTH,
            padding: 24,
            background: THEME.background,
            fontFamily: 'Inter',
            color: THEME.text
        },
        [
            row({ alignItems: 'center', marginBottom: 16 }, [
                column({ flexGrow: 1 }, [
                    text(data.shiftName, { fontSize: 26, fontWeight: 600, color: THEME.text }),
                    text(data.groupName, { fontSize: 14, color: THEME.muted })
                ]),
                text(
                    `${data.renderedAt.toISOString().slice(11, 16)} UTC`,
                    { fontSize: 13, color: THEME.muted }
                )
            ]),

            row({ gap: 10, marginBottom: 16 }, [
                statTile('Vehicles', String(data.vehicles.length)),
                statTile('Routed', `${routed}/${passenger.length}`),
                statTile('Confirmed', `${confirmed}/${passenger.length}`),
                statTile('Dispatchers', String(data.dispatchers)),
                statTile('Busiest route', busiest ? `${busiest[0]} ×${busiest[1]}` : '—')
            ]),

            body,

            data.vehicles.length > MAX_VEHICLES
                ? text(`and ${data.vehicles.length - MAX_VEHICLES} more`, {
                      fontSize: 12,
                      color: THEME.muted,
                      marginTop: 6
                  })
                : null
        ].filter(Boolean)
    )
}

export async function renderManifest(data: ManifestData): Promise<Buffer> {
    // Height is left to satori: a board with six vehicles should not be padded
    // out to the size of one with forty.
    const svg = await satori(board(data) as never, {
        width: WIDTH,
        fonts: await fonts
    })

    return Buffer.from(new Resvg(svg).render().asPng())
}

/**
 * Gathers the live board for a guild, or null when no room is open.
 *
 * Null is the normal case for most of a shift's life, and is what tells the
 * bot to stop asking rather than an error to report.
 */
export async function manifestFor(guildId: string): Promise<Buffer | null> {
    const [row] = await db
        .select({ config: botConfigs, group: groups })
        .from(botConfigs)
        .innerJoin(groups, eq(botConfigs.groupId, groups.id))
        .where(eq(botConfigs.guildId, guildId))
        .limit(1)

    if (!row) return null

    const roomId = await dataRedis.get(groupIndexKey(row.group.id))
    if (!roomId) return null

    const info = await requireRoom(roomId).catch(() => null)
    if (!info) return null

    const vehicles = await DispatchControls.getAllVehicles(roomId, info)

    // Drivers are resolved by Roblox id, which is what the game reports as a
    // vehicle's owner. Anyone the site has never seen stays as a bare id.
    const ownerIds = [...new Set(vehicles.map((vehicle) => vehicle.ownerId))]
    const drivers = new Map<string, string>()

    if (ownerIds.length > 0) {
        const profiles = await db
            .select({
                robloxId: users.robloxId,
                username: users.cachedUsername,
                displayName: users.cachedDisplayName
            })
            .from(users)

        for (const profile of profiles) {
            const key = profile.robloxId.toString()
            if (!ownerIds.includes(key)) continue
            drivers.set(key, profile.displayName ?? profile.username ?? key)
        }
    }

    const present = await dataRedis.hgetall(roomUsersKey(roomId)).catch(() => ({}))
    const dispatchers = Object.values(present).filter((count) => Number(count) > 0).length

    return renderManifest({
        groupName: row.group.cachedName ?? row.group.slug,
        shiftName: info.eventName,
        vehicles,
        drivers,
        dispatchers,
        renderedAt: new Date()
    })
}
