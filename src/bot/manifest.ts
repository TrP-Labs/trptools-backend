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
    unassigned: '#8b949e'
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

/** One vehicle line: route badge, name, driver, note. */
function vehicleRow(vehicle: Vehicles.vehicle, driver: string | null) {
    const label = vehicle.routeName ?? (vehicle.assigned ? '—' : 'Unassigned')
    const colour = vehicle.routeColor ?? THEME.unassigned

    return row(
        {
            alignItems: 'center',
            gap: 12,
            padding: '8px 12px',
            borderRadius: 8,
            background: THEME.surface,
            marginBottom: 6
        },
        [
            // The badge carries the route's own colour, which is the one thing
            // a dispatcher scans a board for.
            el(
                'div',
                {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 74,
                    height: 26,
                    borderRadius: 6,
                    background: colour,
                    color: '#0d1117',
                    fontSize: 14,
                    fontWeight: 600
                },
                label.slice(0, 10)
            ),
            column({ flexGrow: 1, minWidth: 0 }, [
                text(vehicle.name.slice(0, 38), { fontSize: 15, color: THEME.text }),
                text(driver ?? `Owner ${vehicle.ownerId}`, { fontSize: 12, color: THEME.muted })
            ]),
            vehicle.towing ? text('TOW', { fontSize: 11, color: '#f0883e', fontWeight: 600 }) : null,
            vehicle.note ? text(vehicle.note.slice(0, 22), { fontSize: 11, color: THEME.muted }) : null
        ].filter(Boolean)
    )
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
    const shown = data.vehicles.slice(0, MAX_VEHICLES)

    // Two different things, and conflating them misreports a freshly solved
    // board as empty: `routeName` is what the solver decided, while `assigned`
    // is the dispatcher's own tick that they have told the driver.
    const routed = data.vehicles.filter((vehicle) => vehicle.routeName).length
    const confirmed = data.vehicles.filter((vehicle) => vehicle.assigned).length

    // Only real routes are counted here — a service vehicle carries the
    // literal label "SV", which is not a route anybody is busiest on.
    const routeCounts = new Map<string, number>()
    for (const vehicle of shown) {
        if (!vehicle.routeName || !vehicle.routeColor) continue
        routeCounts.set(vehicle.routeName, (routeCounts.get(vehicle.routeName) ?? 0) + 1)
    }

    const busiest = [...routeCounts.entries()].sort((a, b) => b[1] - a[1])[0]

    const twoColumn = shown.length > SINGLE_COLUMN_LIMIT
    const half = Math.ceil(shown.length / 2)

    const rows = shown.map((vehicle) => vehicleRow(vehicle, data.drivers.get(vehicle.ownerId) ?? null))

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
                statTile('Routed', `${routed}/${data.vehicles.length}`),
                statTile('Confirmed', `${confirmed}/${data.vehicles.length}`),
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
