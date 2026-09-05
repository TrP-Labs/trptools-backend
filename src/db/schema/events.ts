import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { visibilityEnum } from './enums'
import { groups } from './groups'
import { translations } from './translations'

/**
 * A shift is a recurring scheduled event. `rrule` drives recurrence,
 * `startTime` anchors the series and `duration` closes each occurrence out.
 *
 * Shifts carry no slots of their own. Who may sign up for what is declared
 * once per rank in `rank_signups`, so adding a shift never means restating the
 * same set of staff roles.
 */
export const events = pgTable(
    'events',
    {
        eventId: uuid('event_id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        /** Address of this shift's own page, unique within the group. */
        slug: text('slug').notNull(),
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        color: text('color').notNull().default('#4287f5'),

        startTime: timestamp('start_time', { withTimezone: true }).notNull(),
        rrule: text('rrule').notNull(),
        /** Minutes. */
        duration: integer('duration').notNull().default(120),

        visibility: visibilityEnum('visibility').notNull().default('PUBLIC'),
        /** Minimum permission level required to host this shift. */
        hostLevel: integer('host_level').notNull().default(2),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('events_group_slug_unique').on(table.groupId, table.slug),
        index('events_group_idx').on(table.groupId)
    ]
)

export const eventsRelations = relations(events, ({ one }) => ({
    group: one(groups, { fields: [events.groupId], references: [groups.id] })
}))

export type Event = typeof events.$inferSelect
