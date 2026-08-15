import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { reportStatusEnum, reportTargetEnum } from './enums'
import { users } from './users'

/**
 * A report against user-supplied content.
 *
 * Filing one hides the target immediately, so anything abusive stops being
 * visible without waiting for a human. A site admin then either approves the
 * content — which restores it and makes it immune to further auto-hiding — or
 * upholds the report and it stays down.
 */
export const reports = pgTable(
    'reports',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        targetType: reportTargetEnum('target_type').notNull(),
        targetId: uuid('target_id').notNull(),

        reason: text('reason').notNull(),
        details: text('details').notNull().default(''),

        status: reportStatusEnum('status').notNull().default('OPEN'),

        reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

        resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
        resolvedAt: timestamp('resolved_at', { withTimezone: true }),
        resolutionNote: text('resolution_note').notNull().default('')
    },
    (table) => [
        index('reports_status_idx').on(table.status, table.createdAt),
        index('reports_target_idx').on(table.targetType, table.targetId),
        index('reports_reporter_idx').on(table.reporterId)
    ]
)

export const reportsRelations = relations(reports, ({ one }) => ({
    reporter: one(users, { fields: [reports.reporterId], references: [users.id] }),
    resolver: one(users, { fields: [reports.resolvedBy], references: [users.id] })
}))

export type Report = typeof reports.$inferSelect

export const REPORT_REASONS = [
    'Sexual or explicit content',
    'Hate or harassment',
    'Violence or threats',
    'Spam or advertising',
    'Impersonation',
    'Other'
] as const
