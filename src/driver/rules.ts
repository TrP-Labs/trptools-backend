import type { DriverModel } from './model'

/**
 * Turns what Redis holds about one vehicle into what its driver is told.
 *
 * Imports one type and nothing else, so `rules.test.ts` can pin it without a
 * database — the same split as `rooms/dispatch/assign.ts`.
 */

type Other = { id: string; name: string; ownerId: string } | null

/** One row of `DRIVER_VIEW`, as the script encodes it. */
export type DriverRow = {
    roomId: string
    vehicle: Record<string, string>
    towing: Other
    towedBy: Other
    room: {
        groupId: string
        eventId: string
        eventName: string
        occurrence: string
        expiresAt: string
        revision: string
        timeline: string
    }
}

type Lookup = {
    groupName: string
    route: (id: string) => { id: string; name: string; color: string } | null
    /** The sentinel a written note stores in place of a route. */
    noteRoute: string
}

type TimelineItem = { id: string; action: string; label: string; audience: string; status: string; awaitingAck?: boolean; changedAt?: number }

const CATEGORIES = new Set(['TROLLEYBUS', 'SERVICE', 'STAFF', 'OTHER'])
const SERVICE_STATUSES = new Set(['AWAITING', 'ENROUTE', 'ON_SCENE', 'RETURNING'])
const ORDERS = new Set(['STOP', 'CONTINUE', 'END_SHIFT'])
const UUID = /^[0-9a-f-]{36}$/i

/** A step the host has sent out, which a driver hears about from dispatch. */
function sent(item: TimelineItem) {
    return item.awaitingAck === true || item.status === 'ACTIVATED' || item.status === 'ACKNOWLEDGED'
}

function readTimeline(raw: string): TimelineItem[] {
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

export function instructionsFor(row: DriverRow, lookup: Lookup): DriverModel.instruction {
    const vehicle = row.vehicle
    const category = (CATEGORIES.has(vehicle.category ?? '') ? vehicle.category : 'OTHER') as DriverModel.instruction['vehicle']['category']

    // A written note is a route in storage (`NOTE`) and an instruction here.
    const stored = vehicle.route ?? ''
    const note = stored === lookup.noteRoute ? (vehicle.note ?? '') : ''
    let route: DriverModel.instruction['route'] = null
    if (stored && stored !== lookup.noteRoute) {
        const known = UUID.test(stored) ? lookup.route(stored) : null
        // A label a dispatcher typed (such as "SV") is shown as typed; an id
        // whose route has since been deleted has nothing honest to show.
        if (known) route = { id: known.id, name: known.name, color: known.color }
        else if (!UUID.test(stored)) route = { id: null, name: stored, color: null }
    }

    const notices = readTimeline(row.room.timeline)
        .filter((item) => sent(item) && (item.action === 'RETURN_DEPOT' || (item.action === 'REMINDER' && item.audience === 'ALL')))
        .map((item) => ({
            id: item.id,
            action: item.action as 'RETURN_DEPOT' | 'REMINDER',
            label: item.label,
            at: typeof item.changedAt === 'number' ? item.changedAt : null
        }))

    const order = ORDERS.has(vehicle.order ?? '') ? (vehicle.order as 'STOP' | 'CONTINUE' | 'END_SHIFT') : null
    const command = vehicle.command === 'QUEUED' || vehicle.command === 'SENT' ? vehicle.command : null

    return {
        roomId: row.roomId,
        groupId: row.room.groupId,
        groupName: lookup.groupName,
        shift: {
            eventId: row.room.eventId,
            name: row.room.eventName,
            occurrence: row.room.occurrence,
            endsAt: Number(row.room.expiresAt) || 0
        },
        vehicle: { id: vehicle.id ?? '', name: vehicle.name ?? '', depot: vehicle.depot ?? '', category },
        route,
        note: note || null,
        confirmed: vehicle.assigned === 'true',
        towing: category === 'SERVICE' ? row.towing : null,
        towedBy: row.towedBy,
        order,
        orderAt: order && Number(vehicle.orderAt) ? Number(vehicle.orderAt) : null,
        delivery: command,
        service: category === 'SERVICE'
            ? {
                status: (SERVICE_STATUSES.has(vehicle.status ?? '') ? vehicle.status : 'AWAITING') as 'AWAITING',
                location: vehicle.location ?? ''
            }
            : null,
        returnToDepot: notices.some((notice) => notice.action === 'RETURN_DEPOT'),
        notices,
        stateIndex: `${Number(vehicle.rev) || 0}.${Number(row.room.revision) || 0}`
    }
}
