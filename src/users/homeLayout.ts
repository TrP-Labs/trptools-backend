export const USER_WIDGETS = ['next', 'my-shifts', 'shifts', 'following', 'today', 'week', 'favorites', 'disliked', 'tools', 'account', 'clock', 'reminders'] as const
export const HOST_WIDGETS = ['next', 'summary', 'groups', 'reviews', 'shifts', 'today', 'week', 'live-rooms', 'host-tools', 'primary', 'tools', 'account', 'clock'] as const
export type HomeWidget = { id: string; width: number }
export type HomeLayout = { user: HomeWidget[]; host: HomeWidget[] }
export const DEFAULT_HOME_LAYOUT: HomeLayout = {
    user: [{ id: 'next', width: 2 }, { id: 'my-shifts', width: 1 }, { id: 'following', width: 2 }, { id: 'shifts', width: 1 }, { id: 'favorites', width: 1 }, { id: 'tools', width: 1 }],
    host: [{ id: 'next', width: 2 }, { id: 'summary', width: 1 }, { id: 'reviews', width: 2 }, { id: 'live-rooms', width: 1 }, { id: 'groups', width: 2 }, { id: 'shifts', width: 1 }]
}
export function validHomeLayout(layout: HomeLayout): boolean {
    return (['user', 'host'] as const).every((mode) => {
        const allowed: readonly string[] = mode === 'user' ? USER_WIDGETS : HOST_WIDGETS
        return layout[mode].length <= allowed.length && new Set(layout[mode].map((w) => w.id)).size === layout[mode].length &&
            layout[mode].every((w) => allowed.includes(w.id) && (w.width === 1 || w.width === 2))
    })
}
