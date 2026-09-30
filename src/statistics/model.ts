import { t } from 'elysia'
export namespace StatisticsModel {
    export const kinds = ['group_view', 'route_view', 'depot_view', 'shift_view', 'join_view_roblox', 'join_view_discord', 'join_click_roblox', 'join_click_discord'] as const
    export const batch = t.Object({ events: t.Array(t.Object({
        id: t.String({ format: 'uuid' }), groupId: t.String({ format: 'uuid' }),
        kind: t.Union(kinds.map(kind => t.Literal(kind))), targetId: t.Optional(t.String({ format: 'uuid' }))
    }), { minItems: 1, maxItems: 8 }) })
    export type batch = typeof batch.static
    const counts = { groupViews: t.Number(), routeViews: t.Number(), depotViews: t.Number(), shiftViews: t.Number(),
        robloxViews: t.Number(), discordViews: t.Number(), robloxClicks: t.Number(), discordClicks: t.Number() }
    export const response = t.Object({
        days: t.Number(), updatedAt: t.Union([t.String(), t.Null()]),
        totals: t.Object(counts), previous: t.Object(counts),
        followers: t.Number(), reminderSubscribers: t.Number(),
        daily: t.Array(t.Object({ day: t.String(), ...counts })),
        routes: t.Array(t.Object({ id: t.String(), name: t.String(), color: t.String(), shape: t.String(), builtIn: t.Boolean(),
            views: t.Number(), votes: t.Number(), favorites: t.Union([t.Number(), t.Null()]), dislikes: t.Union([t.Number(), t.Null()]),
            favoritePercent: t.Union([t.Number(), t.Null()]) }))
    })
    export type response = typeof response.static
}
