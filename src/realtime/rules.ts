/**
 * The decisions behind the hosted-server live feed.
 *
 * Imports nothing, so `rules.test.ts` can pin them without a database or a
 * Redis — the same split as `assign.ts` from `solver.ts` (§7).
 */

/** Longer than the game's slowest interval (60s after its second strike), with room for one late request. */
export const LIVE_WINDOW_MS = 75_000

/** The game handles at most 20 commands per response and ignores the rest. */
export const COMMANDS_PER_RESPONSE = 20

/**
 * The most attendance one request may credit.
 *
 * A feed that stopped for an hour and came back must not be read as an hour
 * of everybody on the server now having been there throughout.
 */
export const ATTENDANCE_STEP_CAP_MS = 65_000

export type GameCommandType = 'Route' | 'Tow' | 'Stop' | 'Continue' | 'EndShift'

export type GameCommand = {
    DispatcherId: number
    Vehicle: number
    Command: { Type: GameCommandType; Value?: string | number }
}

/** What sits in the queue: the command, and what a newer one replaces. */
export type QueuedCommand = { key: string; assignment: boolean; command: GameCommand }

/**
 * Commands that answer the same question about one vehicle replace each other.
 *
 * Two route changes before the game next calls are one decision, and sending
 * both would message the driver twice with the first already wrong. A route
 * and an end of shift are the same question — what this vehicle is assigned —
 * and so are stop and continue. A tow is its own.
 */
export function commandKey(vehicle: number, type: GameCommandType): string {
    const family = type === 'Route' || type === 'EndShift' ? 'assignment' : type === 'Tow' ? 'tow' : 'motion'
    return `${vehicle}:${family}`
}

export function gameVehicleNumber(id: string): number | null {
    if (!/^[0-9]{1,9}$/.test(id)) return null
    const value = Number(id)
    return value > 0 ? value : null
}

export function buildCommand(
    dispatcherRobloxId: number,
    vehicleId: string,
    type: GameCommandType,
    value?: string | number
): QueuedCommand | null {
    const vehicle = gameVehicleNumber(vehicleId)
    if (!vehicle || !Number.isInteger(dispatcherRobloxId) || dispatcherRobloxId <= 0) return null
    const command: GameCommand['Command'] = value === undefined ? { Type: type } : { Type: type, Value: value }
    return {
        key: commandKey(vehicle, type),
        assignment: type === 'Route' || type === 'EndShift',
        command: { DispatcherId: dispatcherRobloxId, Vehicle: vehicle, Command: command }
    }
}

/**
 * The text the game knows a route by.
 *
 * The game identifies routes only by their text, and refuses a route command
 * whose text it does not offer — so a route this server does not run is not
 * worth queueing, and the dispatcher hears about it rather than the command
 * vanishing silently. When the server has not said which it runs, it is sent
 * and left to the game to judge.
 */
export function routeCommandValue(name: string, serverRoutes: string[] | null): string | null {
    if (!serverRoutes) return name
    if (serverRoutes.includes(name)) return name
    return serverRoutes.find((route) => route.toLowerCase() === name.toLowerCase()) ?? null
}

/** Finds a group's route by the game's text: exact first, then ignoring case. */
export function routeByGameName<T extends { id: string; name: string }>(routes: T[], text: string): T | null {
    if (!text) return null
    return routes.find((route) => route.name === text)
        ?? routes.find((route) => route.name.toLowerCase() === text.toLowerCase())
        ?? null
}

/**
 * Whether the game's assignment should replace the board's.
 *
 * The in-game dispatcher boards and this one share one value per vehicle, so
 * an assignment made in the game has to arrive here. But the game only ever
 * reports what it last *received*: while a command of ours is still queued or
 * on its way, its report is older than the board, and adopting it would undo
 * the dispatcher's change before the game had heard of it. So the game wins
 * only when its value has changed since its previous report and nothing of
 * ours is outstanding.
 */
export function shouldAdoptAssignment(previous: string, incoming: string, pending: string): boolean {
    return incoming !== previous && pending === ''
}

/**
 * What the board should store as the route for an assignment the game made.
 *
 * A route TrPTools knows becomes its id, so it is drawn in the group's colours;
 * one it does not is kept as typed, which the board already shows as a literal.
 */
export function adoptedRoute(routes: Array<{ id: string; name: string }>, assigned: string): string {
    if (!assigned) return ''
    return routeByGameName(routes, assigned)?.id ?? assigned
}

/**
 * How many seconds one request credits each person present.
 *
 * Measured from the previous request rather than assumed from the interval,
 * because the game backs off to 30s and 60s after a failure. Capped so a gap
 * in the feed is not credited to whoever happens to be there when it resumes,
 * and clipped to the shift so arriving early or staying late counts nothing.
 */
export function attendanceStep(previousAt: number | null, now: number, start: number, end: number): number {
    if (previousAt === null || now <= previousAt) return 0
    const from = Math.max(previousAt, start, now - ATTENDANCE_STEP_CAP_MS)
    const to = Math.min(now, end)
    return to > from ? Math.round((to - from) / 1000) : 0
}

export function attendancePercent(seconds: number, start: number, end: number): number {
    const length = (end - start) / 1000
    if (length <= 0) return 0
    return Math.min(100, Math.round((seconds / length) * 1000) / 10)
}

export function isLive(lastAt: number | null | undefined, now: number): boolean {
    return Boolean(lastAt) && now - Number(lastAt) < LIVE_WINDOW_MS
}
