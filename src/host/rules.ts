import type { HostModel } from './model'

export const DEFAULT_SCHEDULE: HostModel.Schedule = {
    entries: [
        { id: 'staff', label: 'Open to staff', action: 'STAFF_START', reference: 'START', offsetMinutes: -10, audience: 'HOST', optional: false, automation: true },
        { id: 'edit', label: 'Edit shift information', action: 'EDIT_SHIFT', reference: 'START', offsetMinutes: -5, audience: 'HOST', optional: true, automation: false },
        { id: 'public', label: 'Open to the public', action: 'BEGIN', reference: 'START', offsetMinutes: 0, audience: 'HOST', optional: false, automation: true },
        { id: 'complete', label: 'Complete procedure', action: 'COMPLETE', reference: 'END', offsetMinutes: 5, audience: 'HOST', optional: false, automation: true }
    ],
    depotReminderEnabled: true,
    depotReminderMinutes: 10
}

export const BOT_ACTIONS = new Set(['STAFF_START', 'BEGIN', 'COMPLETE'])
export function dueAt(entry: Pick<HostModel.Entry, 'reference' | 'offsetMinutes'>, start: number, end: number) {
    return (entry.reference === 'START' ? start : end) + entry.offsetMinutes * 60_000
}
export function makeTimeline(schedule: HostModel.Schedule, start: number, end: number, enabled: Record<string, boolean> = {}): HostModel.TimelineEntry[] {
    const entries = [...schedule.entries]
    if (schedule.depotReminderEnabled) entries.push({ id: 'return-depot', label: 'Have drivers return to their depot', action: 'RETURN_DEPOT', reference: 'END', offsetMinutes: -schedule.depotReminderMinutes, audience: 'DISPATCH', optional: false, automation: false })
    return entries.map(entry => ({ ...entry, automation: entry.automation && Boolean(enabled[entry.action]), dueAt: dueAt(entry, start, end), status: 'WAITING' as const })).sort((a,b) => a.dueAt - b.dueAt)
}
export function validSchedule(schedule: HostModel.Schedule) {
    const ids = schedule.entries.map(entry => entry.id)
    const actions = schedule.entries.filter(entry => BOT_ACTIONS.has(entry.action)).map(entry => entry.action)
    return !ids.includes('return-depot') && new Set(ids).size === ids.length && new Set(actions).size === actions.length && !schedule.entries.some(entry => entry.action === 'RETURN_DEPOT')
}
