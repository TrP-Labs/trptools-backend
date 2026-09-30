import { sql } from 'drizzle-orm'
import { status } from 'elysia'
import db from '../db'
import { databaseRows } from '../db/rows'
import { findGroup } from '../groups/service'
import { assertGroupPermission } from '../utils/groupPermission'
import { PERM } from '../utils/permissions'
import type { session } from '../utils/sessionVerifier'
import type { StatisticsModel } from './model'
const countKeys = { group_view: 'groupViews', route_view: 'routeViews', depot_view: 'depotViews', shift_view: 'shiftViews',
    join_view_roblox: 'robloxViews', join_view_discord: 'discordViews', join_click_roblox: 'robloxClicks', join_click_discord: 'discordClicks' } as const
const empty = () => ({ groupViews: 0, routeViews: 0, depotViews: 0, shiftViews: 0, robloxViews: 0, discordViews: 0, robloxClicks: 0, discordClicks: 0 })
export async function groupStatistics(groupId: string, days: number, session: session): Promise<StatisticsModel.response> {
    await assertGroupPermission(session, groupId, PERM.VIEW_DASHBOARD)
    const group = await findGroup(groupId)
    if (!group) throw status(404, 'Not Found')
    const today = new Date(); today.setUTCHours(0, 0, 0, 0)
    const start = new Date(today.getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10)
    const before = new Date(today.getTime() - (2 * days - 1) * 86400_000).toISOString().slice(0, 10)
    // One statistics read: no per-route queries and no per-viewer data in the result.
    const result = await db.execute(sql`SELECT
        (SELECT COUNT(*) FROM group_follows WHERE group_id = ${group.id})::integer AS followers,
        (SELECT COUNT(DISTINCT user_id) FROM notification_watches WHERE group_id = ${group.id})::integer AS reminders,
        (SELECT MAX(processed_at) FROM statistics_events WHERE group_id = ${group.id}) AS updated,
        COALESCE((SELECT jsonb_agg(row_to_json(d)) FROM
            (SELECT day::text, kind, SUM(count)::integer AS count FROM statistics_daily
             WHERE group_id = ${group.id} AND day >= ${before}::date GROUP BY day, kind ORDER BY day) d), '[]'::jsonb) AS daily,
        COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (SELECT r.id, r.name, r.color, r.shape, r.built_in AS "builtIn",
            COALESCE((SELECT SUM(count) FROM statistics_daily WHERE group_id = ${group.id} AND target_id = r.id AND kind = 'route_view' AND day >= ${start}::date), 0)::integer AS views,
            CASE WHEN r.built_in THEN COALESCE(global.favorites, 0) ELSE COALESCE(custom.favorites, 0) END::integer AS favorites,
            CASE WHEN r.built_in THEN COALESCE(global.dislikes, 0) ELSE COALESCE(custom.dislikes, 0) END::integer AS dislikes
            FROM routes r LEFT JOIN (SELECT route_id, COUNT(*) FILTER (WHERE preference = 'FAVORITE') AS favorites,
                COUNT(*) FILTER (WHERE preference = 'DISLIKE') AS dislikes FROM route_preferences p JOIN routes rr ON rr.id = p.route_id
                WHERE rr.group_id = ${group.id} GROUP BY route_id) custom ON custom.route_id = r.id
            LEFT JOIN (SELECT route_name, COUNT(*) FILTER (WHERE preference = 'FAVORITE') AS favorites,
                COUNT(*) FILTER (WHERE preference = 'DISLIKE') AS dislikes FROM global_route_preferences GROUP BY route_name) global ON global.route_name = r.name
            WHERE r.group_id = ${group.id} AND NOT r.archived ORDER BY r.name) r), '[]'::jsonb) AS routes`)
    const row = databaseRows(result)[0]!
    const rows = (typeof row.daily === 'string' ? JSON.parse(row.daily) : row.daily) as { day: string; kind: keyof typeof countKeys; count: number }[]
    const totals = empty(), previous = empty()
    const daily = Array.from({ length: days }, (_, i) => ({ day: new Date(today.getTime() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10), ...empty() }))
    const byDay = new Map(daily.map(day => [day.day, day]))
    for (const value of rows) {
        const key = countKeys[value.kind]; if (!key) continue
        const count = Number(value.count)
        if (value.day >= start) { totals[key] += count; const day = byDay.get(value.day); if (day) day[key] += count }
        else previous[key] += count
    }
    const routes = (typeof row.routes === 'string' ? JSON.parse(row.routes) : row.routes) as { id: string; name: string; color: string; shape: string; builtIn: boolean; views: number; favorites: number; dislikes: number }[]
    return { days, totals, previous, daily, followers: Number(row.followers), reminderSubscribers: Number(row.reminders),
        updatedAt: row.updated ? new Date(String(row.updated)).toISOString() : null,
        routes: routes.map(route => { const votes = route.favorites + route.dislikes; return { ...route, votes,
            favorites: votes >= 5 ? route.favorites : null, dislikes: votes >= 5 ? route.dislikes : null,
            favoritePercent: votes >= 5 ? Math.round(100 * route.favorites / votes) : null } }) }
}
