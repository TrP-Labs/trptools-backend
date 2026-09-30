import { sql } from 'drizzle-orm'
import db from '../db'
import type { StatisticsModel } from './model'
/** One background write validates all targets and deduplicates retries atomically. */
export async function collectStatistics(batch: StatisticsModel.batch) {
    await db.execute(sql`INSERT INTO statistics_events (id, group_id, kind, target_id)
        SELECT input.id, g.id, input.kind, COALESCE(input."targetId", g.id)
        FROM jsonb_to_recordset(${JSON.stringify(batch.events)}::jsonb)
            AS input(id uuid, "groupId" uuid, kind text, "targetId" uuid)
        JOIN groups g ON g.id = input."groupId" AND g.visibility <> 'PRIVATE' AND g.moderation <> 'HIDDEN'
        WHERE (input.kind = 'group_view' AND input."targetId" IS NULL)
            OR (input.kind IN ('join_view_roblox', 'join_click_roblox') AND input."targetId" IS NULL AND g.roblox_join_enabled)
            OR (input.kind IN ('join_view_discord', 'join_click_discord') AND input."targetId" IS NULL AND g.discord_invite <> '')
            OR (input.kind = 'route_view' AND g.show_routes AND EXISTS (SELECT 1 FROM routes r
                WHERE r.id = input."targetId" AND r.group_id = g.id AND r.visibility = 'PUBLIC' AND r.moderation <> 'HIDDEN' AND NOT r.archived))
            OR (input.kind = 'depot_view' AND EXISTS (SELECT 1 FROM depots d
                WHERE d.id = input."targetId" AND d.group_id = g.id AND d.visibility = 'PUBLIC' AND d.moderation <> 'HIDDEN' AND NOT d.archived))
            OR (input.kind = 'shift_view' AND g.show_shifts AND EXISTS (SELECT 1 FROM events e
                WHERE e.event_id = input."targetId" AND e.group_id = g.id AND e.visibility = 'PUBLIC'))
        ON CONFLICT DO NOTHING`)
}
/** Claims and folds a bounded batch in one atomic SQL statement, safe across replicas. */
export async function aggregateStatistics(now = new Date()) {
    await db.execute(sql`WITH claimed AS (
        SELECT id FROM statistics_events WHERE processed_at IS NULL ORDER BY received_at LIMIT 5000 FOR UPDATE SKIP LOCKED
    ), processed AS (
        UPDATE statistics_events SET processed_at = ${now.toISOString()}::timestamptz
        WHERE id IN (SELECT id FROM claimed) RETURNING group_id, kind, target_id, received_at
    ) INSERT INTO statistics_daily (group_id, day, kind, target_id, count)
        SELECT group_id, (received_at AT TIME ZONE 'UTC')::date, kind, target_id, COUNT(*)::integer
        FROM processed GROUP BY group_id, (received_at AT TIME ZONE 'UTC')::date, kind, target_id
        ON CONFLICT (group_id, day, kind, target_id) DO UPDATE SET count = statistics_daily.count + EXCLUDED.count`)
    if (now.getUTCMinutes() === 0) await db.execute(sql`DELETE FROM statistics_events WHERE processed_at IS NOT NULL AND received_at < ${new Date(now.getTime() - 7 * 86400_000).toISOString()}`)
}
